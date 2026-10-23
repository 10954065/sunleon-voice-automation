export type Feedback = { kind: "error" | "success"; text: string } | null;

/** The one-line result message under a form or button. Announced to screen readers. */
export function FeedbackText({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }
  return (
    <p
      role={feedback.kind === "error" ? "alert" : "status"}
      className={feedback.kind === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"}
    >
      {feedback.text}
    </p>
  );
}
