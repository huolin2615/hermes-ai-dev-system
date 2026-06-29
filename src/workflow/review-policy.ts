import type { ClaudeReview } from "../claude/adapter.js";

export function normalizeReviewVerdict(review: ClaudeReview): ClaudeReview {
  if (review.blockers.length === 0) return review;
  return { ...review, verdict: "BLOCK" };
}
