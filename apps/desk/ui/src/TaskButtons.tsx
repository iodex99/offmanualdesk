// Tasks tab: one button per common job (SKILLS.md §5). Choosing a task asks for its
// inputs, then sends one request to the chat.
import { useState } from "react";
import { missingInputs, recentFYs, TASKS, type TaskDef, type TaskInput } from "./tasks";

const realNow = () => new Date();

export function TaskButtons({ onRun, now = realNow }: { onRun: (prompt: string) => void; now?: () => Date }) {
  const [task, setTask] = useState<TaskDef | null>(null);
  const [values, setValues] = useState<Partial<Record<TaskInput, string>>>({});
  const [error, setError] = useState("");
  const fys = recentFYs(now());

  if (!task) {
    return (
      <section aria-label="Tasks">
        <p>Pick a task. You&apos;ll be asked for the client and period.</p>
        <div className="tasks">
          {TASKS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTask(t);
                setValues({ fy: fys[0] ?? "" });
                setError("");
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  const set = (k: TaskInput, v: string) => setValues((old) => ({ ...old, [k]: v }));
  return (
    <form
      aria-label={task.label}
      onSubmit={(e) => {
        e.preventDefault();
        const missing = missingInputs(task, values);
        if (missing.length > 0) {
          setError(`Please fill in: ${missing.join(", ")}.`);
          return;
        }
        onRun(task.prompt(values as Record<TaskInput, string>));
        setTask(null);
      }}
    >
      <h3>{task.label}</h3>
      {task.inputs.includes("client") && (
        <label>
          Client <input value={values.client ?? ""} onChange={(e) => set("client", e.target.value)} />
        </label>
      )}
      {task.inputs.includes("month") && (
        <label>
          Month{" "}
          <input type="month" value={values.month ?? ""} onChange={(e) => set("month", e.target.value)} />
        </label>
      )}
      {task.inputs.includes("fy") && (
        <label>
          Financial year
          <select value={values.fy ?? ""} onChange={(e) => set("fy", e.target.value)}>
            {fys.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      )}
      {task.inputs.includes("period") && (
        <label>
          Period{" "}
          <input
            placeholder="2026-11, Q3-FY2026-27 or FY2026-27"
            value={values.period ?? ""}
            onChange={(e) => set("period", e.target.value)}
          />
        </label>
      )}
      {task.inputs.includes("file") && (
        <label>
          File{" "}
          <input
            placeholder="Full path, e.g. \\fs01\Clients\Mehta\Notices\notice.pdf"
            value={values.file ?? ""}
            onChange={(e) => set("file", e.target.value)}
          />
        </label>
      )}
      <button type="submit">Start</button>{" "}
      <button type="button" onClick={() => setTask(null)}>
        Back
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
