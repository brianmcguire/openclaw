import type { GetReplyOptions } from "../get-reply-options.types.js";

type CommentaryProgressOwnerOptions = Pick<
  GetReplyOptions,
  "onVerboseProgressVisibilityAsync" | "shouldDeliverCommentaryPayloads"
>;

/** Freezes and registers one commentary owner for the current agent turn. */
export async function resolveTurnCommentaryProgressOwner(params: {
  commentaryPayloadsEnabled: boolean;
  options?: CommentaryProgressOwnerOptions;
  resolveVerboseProgressVisibilityAsync: () => Promise<boolean>;
}): Promise<{
  commentaryPayloadsEnabled: boolean;
  draftOwnsCommentaryProgress: boolean;
}> {
  const shouldDeliverCommentaryPayloads = params.commentaryPayloadsEnabled
    ? params.options?.shouldDeliverCommentaryPayloads
    : undefined;
  if (params.options?.onVerboseProgressVisibilityAsync) {
    const frozen = shouldDeliverCommentaryPayloads
      ? await params.resolveVerboseProgressVisibilityAsync()
      : undefined;
    await params.options.onVerboseProgressVisibilityAsync(
      frozen === undefined ? params.resolveVerboseProgressVisibilityAsync : async () => frozen,
    );
  }
  const commentaryPayloadsEnabled =
    params.commentaryPayloadsEnabled && (shouldDeliverCommentaryPayloads?.() ?? true);
  return {
    commentaryPayloadsEnabled,
    draftOwnsCommentaryProgress:
      params.commentaryPayloadsEnabled &&
      shouldDeliverCommentaryPayloads !== undefined &&
      !commentaryPayloadsEnabled,
  };
}
