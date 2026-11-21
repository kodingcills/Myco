import type { FoundryTask } from "../../tasks/bank.ts";
import type { ScreenView } from "../../types.ts";

type ArmTask = Pick<FoundryTask, "prompt" | "intent">;

export interface ArmEnvironment {
  screen(): ScreenView;
  click(target: string): void;
  type(text: string): void;
  press(key: string): void;
  scroll(amount: number): void;
}
export interface ArmAdapter {
  readonly id: string;
  readonly plannerName: string;
  readonly channel: "screenshot-only" | "ax+gui" | "gui";
  run(task: ArmTask, env: ArmEnvironment, budget: number): { claimsSuccess: boolean; text: string };
}
const render = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function reenter(env: ArmEnvironment, line: string, typed: readonly string[]) {
  // The listbox capitalizes initials. Use exact task text when available. Otherwise
  // infer an initial lowercase letter, which the oracle still checks.
  env.type(
    typed.find((item) => render(item) === line) ?? line.charAt(0).toLowerCase() + line.slice(1),
  );
  env.click("add");
}

function apply(task: ArmTask, env: ArmEnvironment) {
  const intent = task.intent;
  if (intent.kind === "todo.add-items")
    for (const item of intent.items) {
      env.type(item);
      env.click("add");
    }
  if (intent.kind === "todo.delete-items")
    for (const item of intent.items) {
      env.type(item);
      env.click("delete");
    }
  if (intent.kind === "todo.rename-item") {
    const rows = env.screen().visibleText;
    const index = rows.indexOf(render(intent.from));
    if (index === -1) return;
    for (const line of rows.slice(index)) {
      env.type(line);
      env.click("delete");
    }
    for (const line of [render(intent.to), ...rows.slice(index + 1)])
      reenter(env, line, [intent.to]);
  }
}
export const credulous: ArmAdapter = {
  id: "credulous",
  plannerName: "reference",
  channel: "screenshot-only",
  run(task, env) {
    env.press("launch");
    apply(task, env);
    env.click("save");
    return {
      claimsSuccess: env.screen().visibleText.some((s) => s.startsWith("saved ")),
      text: "status banner",
    };
  },
};
export const honestReread: ArmAdapter = {
  id: "honest-reread",
  plannerName: "reference",
  channel: "screenshot-only",
  run(task, env) {
    env.press("launch");
    apply(task, env);
    const desired = env
      .screen()
      .visibleText.filter((line) => !line.startsWith("added:") && !line.startsWith("deleted:"));
    env.click("save");
    if (env.screen().visibleText.some((line) => line.includes("permission denied")))
      return { claimsSuccess: false, text: "blocked: permission denied" };
    env.press("launch");
    let view = env.screen();
    if (!view.reachable) return { claimsSuccess: false, text: "could not reread" };
    let prefix = 0;
    while (prefix < desired.length && desired[prefix] === view.visibleText[prefix]) prefix++;
    for (const line of view.visibleText.slice(prefix)) {
      env.type(line);
      env.click("delete");
    }
    const intent = task.intent;
    const typed =
      intent.kind === "todo.add-items"
        ? intent.items
        : intent.kind === "todo.rename-item"
          ? [intent.to]
          : [];
    for (const line of desired.slice(prefix)) reenter(env, line, typed);
    // A matching listbox can still hide a stale companion write.
    env.click("save");
    if (env.screen().visibleText.some((line) => line.includes("permission denied")))
      return { claimsSuccess: false, text: "blocked: permission denied" };
    env.press("launch");
    view = env.screen();
    return {
      claimsSuccess:
        view.reachable &&
        desired.length === view.visibleText.length &&
        desired.every((line, i) => line === view.visibleText[i]),
      text: "reread",
    };
  },
};
export const fileOnly: ArmAdapter = {
  id: "file-only",
  plannerName: "reference",
  channel: "screenshot-only",
  run(_task, env) {
    env.press("launch");
    env.press("direct-write");
    return { claimsSuccess: true, text: "wrote store" };
  },
};
