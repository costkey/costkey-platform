/**
 * Replace the browser's validation bubbles with the console's own inline
 * message under the field, for every form, without per-form code. Fields
 * keep their native constraints (required, type, minLength...); only the
 * presentation changes.
 */

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isField(target: EventTarget | null): target is Field {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

function messageFor(field: Field): string {
  const { validity } = field;
  const input = field instanceof HTMLInputElement ? field : null;
  if (validity.valueMissing) return input?.type === "checkbox" ? "Tick this to continue." : "Required.";
  if (validity.typeMismatch && input?.type === "email") return "Enter an email address.";
  if (validity.typeMismatch && input?.type === "url") return "Enter a full URL, starting with https://.";
  if (validity.tooShort && input) return `At least ${input.minLength} characters.`;
  if (validity.tooLong && input) return `At most ${input.maxLength} characters.`;
  if (validity.rangeUnderflow && input) return `${input.min} or more.`;
  if (validity.rangeOverflow && input) return `${input.max} or less.`;
  if (validity.stepMismatch) return "Enter a whole number.";
  if (validity.badInput) return "Enter a number.";
  if (validity.patternMismatch) return field.getAttribute("title") || "Check the format.";
  return field.validationMessage || "Check this field.";
}

const errors = new WeakMap<Field, HTMLElement>();

function clear(field: Field): void {
  const node = errors.get(field);
  if (node) node.remove();
  errors.delete(field);
  field.removeAttribute("aria-invalid");
  field.removeAttribute("aria-describedby");
}

function show(field: Field): void {
  let node = errors.get(field);
  if (!node) {
    node = document.createElement("span");
    node.className = "ck-field-error";
    node.id = `ck-field-error-${Math.random().toString(36).slice(2, 9)}`;
    node.setAttribute("role", "alert");
    // Sit after the field, or after its wrapper when the field is inside a
    // composite control (an input with an inline prefix or button).
    const anchor = field.parentElement && field.parentElement.children.length > 1 && !field.parentElement.matches("label, form, fieldset, [class*='field']")
      ? field.parentElement
      : field;
    anchor.insertAdjacentElement("afterend", node);
    errors.set(field, node);
  }
  node.textContent = messageFor(field);
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", node.id);
}

let focusedThisSubmit = false;

export function installFieldValidation(): void {
  document.addEventListener("invalid", (event) => {
    if (!isField(event.target)) return;
    event.preventDefault();
    show(event.target);
    if (!focusedThisSubmit) {
      focusedThisSubmit = true;
      event.target.focus();
      // Invalid events for one submit arrive in the same task; reset after it.
      window.setTimeout(() => { focusedThisSubmit = false; }, 0);
    }
  }, true);
  const recheck = (event: Event) => {
    if (!isField(event.target) || !errors.has(event.target)) return;
    if (event.target.checkValidity()) clear(event.target);
    else show(event.target);
  };
  document.addEventListener("input", recheck, true);
  document.addEventListener("change", recheck, true);
}
