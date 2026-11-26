interface TempStop {
  temp: number;
  rgb: [number, number, number];
}

const TEMP_STOPS: TempStop[] = [
  { temp: 40, rgb: [56, 189, 248] },  // #38bdf8 cool blue
  { temp: 52, rgb: [52, 211, 153] },  // #34d399 emerald/mint
  { temp: 62, rgb: [251, 191, 36] },  // #fbbf24 warm amber
  { temp: 72, rgb: [251, 146, 60] },  // #fb923c orange
  { temp: 80, rgb: [239, 68, 68] },   // #ef4444 alert red
];

export function getTemperatureColor(rawOrFormattedTemp: unknown): string {
  // Supports either a number in °C (e.g. 54.2) or formatted string like "54.2°C"
  const numericMatch = String(rawOrFormattedTemp ?? '').match(/-?\d+(\.\d+)?/);
  if (!numericMatch) return '#38bdf8';

  const tempC = parseFloat(numericMatch[0]);
  if (Number.isNaN(tempC)) return '#38bdf8';

  if (tempC <= TEMP_STOPS[0].temp) {
    const [r, g, b] = TEMP_STOPS[0].rgb;
    return `rgb(${r}, ${g}, ${b})`;
  }

  const last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (tempC >= last.temp) {
    const [r, g, b] = last.rgb;
    return `rgb(${r}, ${g}, ${b})`;
  }

  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    const start = TEMP_STOPS[i];
    const end = TEMP_STOPS[i + 1];

    if (tempC >= start.temp && tempC <= end.temp) {
      const ratio = (tempC - start.temp) / (end.temp - start.temp);
      const r = Math.round(start.rgb[0] + (end.rgb[0] - start.rgb[0]) * ratio);
      const g = Math.round(start.rgb[1] + (end.rgb[1] - start.rgb[1]) * ratio);
      const b = Math.round(start.rgb[2] + (end.rgb[2] - start.rgb[2]) * ratio);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }

  return '#38bdf8';
}