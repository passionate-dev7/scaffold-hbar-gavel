import type { StepRun } from "~~/hooks/desk/useTx";
import { hashscan } from "~~/utils/desk/hedera";

export type PlannedStep = { id: string; label: string; hint?: string; needed: boolean };

const STATUS_TEXT: Record<StepRun["status"], string> = {
  signing: "Confirm in your wallet",
  confirming: "Waiting for consensus",
  done: "Done",
  failed: "Failed",
};

const Glyph = ({ run, needed }: { run?: StepRun; needed: boolean }) => {
  if (run?.status === "signing" || run?.status === "confirming") {
    return <span className="animate-pulse-fast text-link">[~]</span>;
  }
  if (run?.status === "done" || !needed) return <span className="text-ok">[x]</span>;
  if (run?.status === "failed") return <span className="text-bad">[!]</span>;
  return <span className="text-mute">[ ]</span>;
};

/** The transactions a button will send, each with where it stands. Steps already satisfied read as done. */
export const TxSteps = ({ steps, runs }: { steps: PlannedStep[]; runs: Record<string, StepRun> }) => (
  <ol className="m-0 flex list-none flex-col gap-3 p-0 text-sm">
    {steps.map(step => {
      const run = runs[step.id];
      return (
        <li key={step.id} className="flex items-start gap-3">
          <span className="shrink-0 whitespace-pre" aria-hidden>
            <Glyph run={run} needed={step.needed} />
          </span>
          <div className="min-w-0 grow">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className={!step.needed && !run ? "text-mute" : "font-bold"}>{step.label}</span>
              <span className="text-xs text-mute">
                {run ? STATUS_TEXT[run.status] : step.needed ? "Waiting" : "Not needed"}
                {run?.hash && (
                  <>
                    {" · "}
                    <a className="link" href={hashscan.tx(run.hash)} target="_blank" rel="noreferrer">
                      HashScan
                    </a>
                  </>
                )}
              </span>
            </div>
            {step.hint && !run && <p className="m-0 text-xs text-mute">{step.hint}</p>}
            {run?.status === "failed" && run.error && (
              <p className="m-0 mt-1 text-xs text-bad" role="alert">
                {run.error}
              </p>
            )}
          </div>
        </li>
      );
    })}
  </ol>
);
