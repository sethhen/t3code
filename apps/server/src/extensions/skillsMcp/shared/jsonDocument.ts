/**
 * Small JSON documents under `<stateDir>/skills-mcp/`. Writes go to a temp
 * file and are renamed into place, and every read-modify-write of one file is
 * serialized by a module-level lock shared by all ws connections.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ExtensionFailure, ServerConfig } from "./t3.ts";

/** `<T3 state dir>/skills-mcp`, created on demand. */
export const extensionDataDir = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const dir = path.join(config.stateDir, "skills-mcp");
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) => new ExtensionFailure({ message: `Could not create ${dir}`, cause }),
      ),
    );
  return dir;
});

const locks = new Map<string, Semaphore.Semaphore>();
const lockFor = (file: string) => {
  let lock = locks.get(file);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(file, lock);
  }
  return lock;
};

type PlainSchema = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

/** Call at module scope: compiles the codecs once. */
export const makeJsonDocument = <S extends PlainSchema>(
  fileName: string,
  schema: S,
  empty: () => S["Type"],
) => {
  const codec = Schema.fromJsonString(schema);
  const decode = Schema.decodeUnknownEffect(codec);
  const encode = Schema.encodeUnknownEffect(codec);

  const filePath = Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(yield* extensionDataDir, fileName);
  });

  const readAt = (file: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return empty();
      const text = yield* fs.readFileString(file);
      return yield* decode(text);
    }).pipe(
      Effect.mapError(
        (cause) => new ExtensionFailure({ message: `Could not read ${file}`, cause }),
      ),
    );

  const read = Effect.flatMap(filePath, readAt);

  /** Read, transform, and atomically write the document under its lock. */
  const update = <A, E, R>(
    transform: (current: S["Type"]) => Effect.Effect<readonly [A, S["Type"]], E, R>,
  ) =>
    Effect.gen(function* () {
      const file = yield* filePath;
      const fs = yield* FileSystem.FileSystem;
      return yield* lockFor(file).withPermit(
        Effect.gen(function* () {
          const [result, next] = yield* transform(yield* readAt(file));
          const text = yield* encode(next).pipe(
            Effect.mapError(
              (cause) => new ExtensionFailure({ message: `Could not encode ${file}`, cause }),
            ),
          );
          const temp = `${file}.tmp`;
          yield* fs.writeFileString(temp, `${text}\n`).pipe(
            Effect.andThen(fs.rename(temp, file)),
            Effect.mapError(
              (cause) => new ExtensionFailure({ message: `Could not write ${file}`, cause }),
            ),
          );
          return result;
        }),
      );
    });

  return { read, update, filePath } as const;
};
