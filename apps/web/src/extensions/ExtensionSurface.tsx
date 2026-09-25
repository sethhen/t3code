import { Suspense } from "react";

import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";

import { findRightPanelExtension, type RightPanelExtensionProps } from "./registry";

/** Renders a fork extension's right-panel surface by id. */
export function ExtensionSurface(
  props: RightPanelExtensionProps & { readonly extensionId: string },
) {
  const { extensionId, ...panelProps } = props;
  const extension = findRightPanelExtension(extensionId);
  if (!extension) {
    return (
      <Empty>
        <EmptyTitle>Extension unavailable</EmptyTitle>
        <EmptyDescription>This build does not include the “{extensionId}” panel.</EmptyDescription>
      </Empty>
    );
  }
  const { Panel } = extension;
  return (
    <Suspense fallback={null}>
      <Panel {...panelProps} />
    </Suspense>
  );
}
