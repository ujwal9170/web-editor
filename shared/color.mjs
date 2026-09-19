export function normalizeHex(value) {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) return "#" + [...hex].map(c => c + c).join("").toUpperCase();
  return /^[\da-f]{6}$/i.test(hex) ? "#" + hex.toUpperCase() : null;
}

export function colorGrid() {
  const colours = [];
  for (let i = 0; i < 8; i++) colours.push("#" + Math.round(255 * (1 - i / 7)).toString(16).padStart(2, "0").repeat(3).toUpperCase());
  for (const lightness of [0.85, 0.7, 0.55, 0.4, 0.25]) {
    for (let hue = 0; hue < 360; hue += 45) {
      const a = 0.9 * Math.min(lightness, 1 - lightness);
      const channel = n => {
        const k = (n + hue / 30) % 12;
        return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
      };
      colours.push(("#" + channel(0) + channel(8) + channel(4)).toUpperCase());
    }
  }
  return colours;
}
