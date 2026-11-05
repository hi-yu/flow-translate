import { LANGUAGES } from './settings';

export function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing UI element: ' + id);
  return element as T;
}

export function languages(select: HTMLSelectElement, value: string): void {
  select.replaceChildren(
    ...LANGUAGES.map(([code, name]) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = name;
      return option;
    }),
  );
  select.value = value;
}

export function status(id: string, text: string, error = false): void {
  const element = el(id);
  element.textContent = text;
  element.dataset.error = String(error);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
