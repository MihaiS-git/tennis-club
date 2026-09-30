// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SearchableCombobox } from "../../src/components/searchable-combobox";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Charlie" },
];

afterEach(cleanup);

it("opens on focus, marks the current option, and selects with arrows and Enter", () => {
  const onValueChange = vi.fn();
  render(<><label htmlFor="choice">Choice</label>
    <SearchableCombobox id="choice" name="choice" options={options} defaultValue="b"
      onValueChange={onValueChange} placeholder="Choose" listLabel="Choices" emptyMessage="None" /></>);
  const input = screen.getByRole("combobox", { name: "Choice" }) as HTMLInputElement;
  expect(input.value).toBe("Beta");
  fireEvent.focus(input);
  const list = screen.getByRole("listbox", { name: "Choices" });
  expect(within(list).getByRole("option", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe(within(list).getByRole("option", { name: "Beta" }).id);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(within(list).getByRole("option", { name: "Charlie" }).id);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.getAttribute("aria-activedescendant")).toBe(within(list).getByRole("option", { name: "Beta" }).id);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("Charlie");
  expect((document.querySelector('input[name="choice"]') as HTMLInputElement).value).toBe("c");
  expect(onValueChange).toHaveBeenCalledWith("c");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("closes on Escape or outside click without changing the selected value", () => {
  const onValueChange = vi.fn();
  render(<><label htmlFor="choice">Choice</label>
    <SearchableCombobox id="choice" options={options} defaultValue="b"
      onValueChange={onValueChange} placeholder="Choose" listLabel="Choices" emptyMessage="None" />
    <button type="button">Outside</button></>);
  const input = screen.getByRole("combobox", { name: "Choice" }) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "alpha" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("Beta");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(input);
  expect(screen.getByRole("listbox", { name: "Choices" })).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(input.value).toBe("Beta");
  expect(onValueChange).not.toHaveBeenCalled();
});

it("filters options and selects one by mouse", () => {
  const onValueChange = vi.fn();
  render(<><label htmlFor="choice">Choice</label>
    <SearchableCombobox id="choice" options={options} defaultValue="a"
      onValueChange={onValueChange} placeholder="Choose" listLabel="Choices" emptyMessage="None" /></>);
  const input = screen.getByRole("combobox", { name: "Choice" }) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "char" } });
  const list = screen.getByRole("listbox", { name: "Choices" });
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  const option = within(list).getByRole("option", { name: "Charlie" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  expect(input.value).toBe("Charlie");
  expect(onValueChange).toHaveBeenCalledWith("c");
});
