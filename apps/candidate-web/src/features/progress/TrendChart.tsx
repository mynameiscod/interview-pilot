import {
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from 'chart.js';
import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { cssToken } from './progress-format';

// Only what a line chart needs, so the lazily loaded chunk stays small.
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip);

export interface TrendChartProps {
  labels: string[];
  values: (number | null)[];
  /** Text alternative for the canvas (the table beside it has the full data). */
  summary: string;
}

/**
 * Readiness over time (0–100). Colours are read from the design tokens at
 * render time, so the chart follows the theme without raw colour values.
 * Loaded lazily: Chart.js stays out of the dashboard's first chunk.
 */
export default function TrendChart({ labels, values, summary }: TrendChartProps) {
  const colors = useMemo(
    () => ({
      line: cssToken('--cb-primary'),
      point: cssToken('--cb-secondary-strong'),
      grid: cssToken('--cb-border'),
      text: cssToken('--cb-text-secondary'),
    }),
    [],
  );
  const data: ChartData<'line', (number | null)[], string> = {
    labels,
    datasets: [
      {
        data: values,
        borderColor: colors.line,
        backgroundColor: colors.point,
        pointBackgroundColor: colors.point,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2,
        tension: 0.3,
        spanGaps: true,
      },
    ],
  };
  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: {
        min: 0,
        max: 100,
        ticks: { color: colors.text, stepSize: 25 },
        grid: { color: colors.grid },
      },
      x: {
        ticks: { color: colors.text, maxRotation: 0, autoSkip: true },
        grid: { display: false },
      },
    },
    plugins: { legend: { display: false }, tooltip: { displayColors: false } },
  };
  return (
    <div className="cb-trend-chart">
      <Line data={data} options={options} role="img" aria-label={summary} />
    </div>
  );
}
