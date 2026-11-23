import { readGamepadInput } from "/runtime/dolphin/src/input.js";

const BUTTON_KEYS = {
  KeyX: 0, KeyZ: 1, KeyV: 2, KeyB: 3, KeyQ: 4, KeyE: 5, KeyC: 8, Enter: 9,
  ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15
};
const AXIS_KEYS = [
  ["KeyA", "KeyD"], ["KeyW", "KeyS"], ["KeyJ", "KeyL"], ["KeyI", "KeyK"]
];

export const CONTROL_KEYS = new Set([...Object.keys(BUTTON_KEYS), ...AXIS_KEYS.flat()]);
export const NEUTRAL_INPUT = Object.freeze({ buttons: 0, axes: Object.freeze([0, 0, 0, 0]) });

export function readControls(keys, gamepad) {
  let buttons = 0;
  for (const [code, index] of Object.entries(BUTTON_KEYS)) {
    if (keys.has(code)) buttons |= 1 << index;
  }
  for (let index = 0; index < 16; index++) {
    if (gamepad?.buttons[index]?.pressed) buttons |= 1 << index;
  }
  const axes = AXIS_KEYS.map(([negative, positive], index) => {
    const keyboard = Number(keys.has(positive)) - Number(keys.has(negative));
    return keyboard || gamepad?.axes[index] || 0;
  });
  return { buttons, axes };
}

export function toDolphinInput(input) {
  return readGamepadInput({
    axes: input.axes,
    buttons: Array.from({ length: 16 }, (_, index) => {
      const pressed = Boolean(input.buttons & (1 << index));
      return { pressed, value: Number(pressed) };
    })
  }).state;
}
