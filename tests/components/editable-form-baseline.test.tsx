// @vitest-environment jsdom
import { StrictMode, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEditableFormBaseline } from "../../src/components/use-editable-form-baseline";

afterEach(cleanup);

function Editor({ initial = "Original", disabled = false, lockPending = true,
  save = async () => true, customValidation = true, composedRef = false }: {
  initial?: string; disabled?: boolean; lockPending?: boolean;
  save?: () => Promise<boolean>; customValidation?: boolean; composedRef?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [renderCount, setRenderCount] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  const baseline = useEditableFormBaseline(["name", "country", "choices", "notes", "enabled"],
    (field, value) => field === "country" ? value.trim().toUpperCase() : value.trim(),
    customValidation ? (form) => String(new FormData(form).get("name") ?? "").trim().length >= 3 : undefined);
  return <>
    <output aria-label="Dirty">{String(baseline.dirty)}</output>
    <output aria-label="Valid">{String(baseline.valid)}</output>
    <output aria-label="Render count">{renderCount}</output>
    {error && <p role="alert">Save failed</p>}
    <button onClick={() => setOpen((value) => !value)}>{open ? "Close" : "Open"}</button>
    <button onClick={() => setRenderCount((value) => value + 1)}>Rerender</button>
    <button onClick={baseline.reset}>Reset</button>
    {open && <form aria-label="Editor" ref={composedRef ? (form) => { formRef.current = form; baseline.attach(form); } : baseline.attach}
      onInput={baseline.sync} onChange={baseline.sync} onSubmit={async (event) => {
        event.preventDefault();
        const saved = baseline.submitted(event.currentTarget);
        setPending(true);
        setError(false);
        try {
          if (await save()) baseline.commit(saved);
          else setError(true);
        } catch { setError(true); }
        finally { setPending(false); }
      }}>
      <fieldset disabled={disabled || (lockPending && pending)}>
        <input aria-label="Name" name="name" defaultValue={initial} required minLength={3} />
        <input aria-label="Country" name="country" defaultValue="ro" />
        <select aria-label="Choices" name="choices" multiple defaultValue={["a", "b"]}>
          <option value="a">A</option><option value="b">B</option><option value="c">C</option>
        </select>
        <textarea aria-label="Notes" name="notes" defaultValue="Notes" />
        <input aria-label="Enabled" name="enabled" type="checkbox" defaultChecked />
      </fieldset>
      <button type="submit" disabled={pending || !baseline.dirty || !baseline.valid}>Save</button>
    </form>}
  </>;
}

const dirty = () => screen.getByLabelText("Dirty").textContent;
const valid = () => screen.getByLabelText("Valid").textContent;
const name = () => screen.getByLabelText("Name");
const changeName = (value: string) => fireEvent.change(name(), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Editor" }));

it.each([["Original", "true"], ["", "false"], ["  ", "false"]])("evaluates initial validity for %j", (initial, expected) => {
  render(<StrictMode><Editor initial={initial} /></StrictMode>);
  expect(dirty()).toBe("false");
  expect(valid()).toBe(expected);
});

it("uses native validity when no validator is supplied", () => {
  render(<Editor initial="" customValidation={false} />);
  expect(valid()).toBe("false");
  changeName("Valid");
  expect(valid()).toBe("true");
});

it("keeps touch pristine and clears dirtiness on revert", () => {
  render(<Editor />);
  fireEvent.focus(name()); fireEvent.blur(name()); fireEvent.input(name());
  expect(dirty()).toBe("false");
  changeName("Changed"); expect(dirty()).toBe("true");
  changeName("Original"); expect(dirty()).toBe("false");
  changeName(""); expect(valid()).toBe("false");
  changeName("Original"); expect(valid()).toBe("true");
});

it("compares trimmed and case-normalized values", () => {
  render(<Editor />);
  changeName(" Original ");
  fireEvent.change(screen.getByLabelText("Country"), { target: { value: " RO " } });
  expect(dirty()).toBe("false");
});

it("compares repeated values independently of selection order", () => {
  render(<Editor />);
  const select = screen.getByLabelText("Choices");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Expected select");
  select.append(select.options[0]);
  fireEvent.change(select);
  expect(dirty()).toBe("false");
  select.options[0].selected = false;
  fireEvent.change(select);
  expect(dirty()).toBe("true");
});

it("retains the baseline across callback-ref reattachments", () => {
  render(<Editor composedRef />);
  changeName("Changed");
  fireEvent.click(screen.getByText("Rerender"));
  expect(dirty()).toBe("true");
  changeName("Original"); expect(dirty()).toBe("false");
});

it("commits submitted values while the fieldset remains disabled", async () => {
  let finish: (saved: boolean) => void = () => { throw new Error("Not submitted"); };
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  render(<Editor save={save} />);
  changeName("Saved");
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New notes" } });
  const select = screen.getByLabelText("Choices");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Expected select");
  select.options[1].selected = false; select.options[2].selected = true;
  fireEvent.change(select);
  fireEvent.click(screen.getByLabelText("Enabled"));
  submit();
  expect(name().matches(":disabled")).toBe(true);
  await act(async () => finish(true));
  expect(dirty()).toBe("false"); expect(valid()).toBe("true");
  expect(name().matches(":disabled")).toBe(false);
  changeName("Original"); expect(dirty()).toBe("true");
  changeName("Saved"); expect(dirty()).toBe("false");
});

it.each([["Original", "true"], ["", "false"]])("reads initially disabled values %j without unlocking the live form", async (initial, expected) => {
  render(<Editor disabled initial={initial} />);
  expect(valid()).toBe(expected);
  changeName("Saved"); submit();
  await waitFor(() => expect(dirty()).toBe("false"));
  expect(valid()).toBe("true");
  expect(name().matches(":disabled")).toBe(true);
});

it.each([false, true])("keeps newer pending edits dirty after committing only the submitted draft (locked: %j)", async (lockPending) => {
  let finish: (saved: boolean) => void = () => { throw new Error("Not submitted"); };
  render(<Editor lockPending={lockPending} save={() => new Promise((resolve) => { finish = resolve; })} />);
  changeName("Submitted"); submit(); changeName("Newer edit");
  await act(async () => finish(true));
  expect(dirty()).toBe("true");
  expect(name()).toHaveProperty("value", "Newer edit");
  changeName("Submitted"); expect(dirty()).toBe("false");
});

it("preserves newer invalid edits and the persisted baseline after an asynchronous failure", async () => {
  let finish: (saved: boolean) => void = () => { throw new Error("Not submitted"); };
  render(<Editor lockPending={false} save={() => new Promise((resolve) => { finish = resolve; })} />);
  changeName("Submitted"); submit(); changeName("");
  await act(async () => finish(false));
  expect(name()).toHaveProperty("value", "");
  expect(dirty()).toBe("true"); expect(valid()).toBe("false");
  changeName("Original"); expect(dirty()).toBe("false"); expect(valid()).toBe("true");
  changeName("Retry draft");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
});

it.each([false, "throw"])("retains the draft and original baseline on failure %j and permits retry", async (failure) => {
  const save = vi.fn().mockImplementationOnce(async () => {
    if (failure === "throw") throw new Error("Network failure");
    return false;
  }).mockResolvedValue(true);
  render(<Editor save={save} />);
  changeName("Retry draft"); submit();
  await screen.findByRole("alert");
  expect(name()).toHaveProperty("value", "Retry draft");
  expect(dirty()).toBe("true"); expect(valid()).toBe("true");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  changeName("Original"); expect(dirty()).toBe("false");
  changeName("Retry draft"); submit();
  await waitFor(() => expect(dirty()).toBe("false"));
  expect(save).toHaveBeenCalledTimes(2);
});

it.each(["", "Original"])("starts a fresh Create/Edit session after closing %j", (initial) => {
  const { rerender } = render(<Editor initial={initial} />);
  changeName("Previous draft");
  expect(dirty()).toBe("true"); expect(valid()).toBe("true");
  fireEvent.click(screen.getByText("Close"));
  rerender(<Editor initial={initial ? "Refreshed record" : ""} />);
  fireEvent.click(screen.getByText("Open"));
  expect(dirty()).toBe("false");
  expect(valid()).toBe(initial ? "true" : "false");
  changeName("Previous draft"); expect(dirty()).toBe("true");
  changeName(initial ? "Refreshed record" : ""); expect(dirty()).toBe("false");
});

it("resets the baseline and validity of an existing mounted editor", () => {
  render(<Editor />);
  changeName("");
  fireEvent.click(screen.getByText("Reset"));
  expect(dirty()).toBe("false"); expect(valid()).toBe("false");
  changeName("Original"); expect(dirty()).toBe("true");
});
