import { useContext, useRef, useState } from "react";
import type { Snapshot } from "../../src/shared/types";
import { BudgetSettingsContext } from "../budget/BudgetDialog";
import { CH_TEXT, ExperimentalDialog } from "../floors/ChannelDialogs";

/** 위쪽 막대의 "실험 기능"(Phase 4b 3장). 켜져 있으면 "켜짐"을 덧붙인다 */
export function ExperimentalChip({ exp }: { exp: NonNullable<Snapshot["experimental"]> }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { announce } = useContext(BudgetSettingsContext);
  return (
    <>
      <button ref={btn} type="button" className={`q-chip exp-chip${exp.channels ? " on" : ""}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {CH_TEXT.expButton}
        {exp.channels ? " · 켜짐" : ""}
      </button>
      {open && (
        <ExperimentalDialog
          exp={exp}
          announce={announce}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        />
      )}
    </>
  );
}
