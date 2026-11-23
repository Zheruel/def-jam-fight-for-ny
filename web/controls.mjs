const BUTTON_KEYS = {
  KeyZ: 0, KeyX: 1, KeyA: 2, KeyS: 3, Digit1: 4, Digit8: 5, Digit2: 6, Digit9: 7,
  Backspace: 8, Enter: 9, Digit3: 10, Digit0: 11,
  ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15
};
const AXES = [['KeyF', 'KeyH'], ['KeyT', 'KeyG'], ['KeyJ', 'KeyL'], ['KeyI', 'KeyK']];
export const CONTROL_KEYS = new Set([...Object.keys(BUTTON_KEYS), ...AXES.flat()]);
export const NEUTRAL_INPUT = { buttons: 0, axes: [0, 0, 0, 0] };

export function readControls(keys, gamepad) {
  let buttons = 0;
  for (const [code, index] of Object.entries(BUTTON_KEYS)) {
    if (keys.has(code) || gamepad?.buttons[index]?.pressed) buttons |= 1 << index;
  }
  const axes = AXES.map(([negative, positive], i) =>
    Number(keys.has(positive)) - Number(keys.has(negative)) || gamepad?.axes[i] || 0);
  return { buttons, axes };
}
