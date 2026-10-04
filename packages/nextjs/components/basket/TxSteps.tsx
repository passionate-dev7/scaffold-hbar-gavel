import { CheckIcon, XMarkIcon } from "@heroicons/react/24/solid";
import type { StepRun } from "~~/hooks/basket/useTx";
import { hashscan } from "~~/utils/basket/hedera";

export type PlannedStep = { id: string; label: string; hint?: string; needed: boolean };

const STATUS_TEXT: Record<StepRun["status"], string> = {
  signing: "Confirm in your wallet",
  confirming: "Waiting for consensus",
  done: "Done",
  failed: "Failed",
};

const Glyph = ({ run, needed }: { run?: StepRun; needed: boolean }) => {
  if (run?.status === "signing" || run?.status === "confirming") {
    return <span className="loading loading-spinner loading-xs text-primary" aria-hidden />;
  }
  if (run?.status === "done" || !needed) {
    return (
      <span className="grid h-4 w-4 place-items-center rounded-full bg-success/15 text-success" aria-hidden>
        <CheckIcon className="h-3 w-3" />
      </span>
    );
  }
  if (run?.status === "failed") {
    return (
      <span className="grid h-4 w-4 place-items-center rounded-full bg-error/15 text-error" aria-hidden>
        <XMarkIcon className="h-3 w-3" />
      </span>
    );
  }
  return <span className="h-4 w-4 rounded-full border border-base-content/30" aria-hidden />;
};

/** The transactions a button will send, each with where it stands. Steps already satisfied read as done. */
export const TxSteps = ({ steps, runs }: { steps: PlannedStep[]; runs: Record<string, StepRun> }) => (
  <ol className="m-0 flex list-none flex-col gap-3 p-0">
    {steps.map(step => {
      const run = runs[step.id];
      return (
        <li key={step.id} className="flex items-start gap-3">
          <span className="mt-0.5">
            <Glyph run={run} needed={step.needed} />
          </span>
          <div className="min-w-0 grow">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className={`text-sm ${!step.needed && !run ? "text-base-content/70" : "font-medium"}`}>
                {step.label}
              </span>
              <span className="text-xs text-base-content/70">
                {run ? STATUS_TEXT[run.status] : step.needed ? "Waiting" : "Not needed"}
                {run?.hash && (
                  <>
                    {" · "}
                    <a className="link link-primary" href={hashscan.tx(run.hash)} target="_blank" rel="noreferrer">
                      HashScan
                    </a>
                  </>
                )}
              </span>
            </div>
            {step.hint && !run && <p className="m-0 text-xs text-base-content/70">{step.hint}</p>}
            {run?.status === "failed" && run.error && (
              <p className="m-0 mt-1 text-xs text-error" role="alert">
                {run.error}
              </p>
            )}
          </div>
        </li>
      );
    })}
  </ol>
);
