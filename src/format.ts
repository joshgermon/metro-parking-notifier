import { TIMEZONE } from './time';
import type { FillRate, ZoneResult } from './transport';

export const renderGauge = (percent: number, width: number = 20): string => {
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return '●'.repeat(filled) + '○'.repeat(empty);
};

export const getStatusText = (percent: number): string => {
	if (percent >= 95) return 'ALMOST FULL - leave now!';
	if (percent >= 90) return 'NEARLY FULL - hurry!';
	if (percent >= 75) return 'Busy - limited spots';
	if (percent >= 50) return 'Moderate - filling up';
	return 'Plenty of spots available';
};

export const formatFillRate = (fillRate: FillRate | null, opts?: { onlyPositive?: boolean }): string => {
	if (!fillRate) return '';
	if (opts?.onlyPositive && fillRate.spotsPerMin <= 0) return '';

	const arrow = fillRate.spotsPerMin > 0 ? '📈' : fillRate.spotsPerMin < 0 ? '📉' : '➡️';
	const sign = fillRate.spotsPerMin > 0 ? '+' : '';
	return `${arrow} Fill Rate: ${sign}${fillRate.spotsPerMin} spots/min (${fillRate.description})`;
};

export const formatUpdatedTime = (timestamp: number): string => {
	const secondsAgo = Math.round((Date.now() - timestamp) / 1000);
	if (secondsAgo < 5) return 'just now';
	if (secondsAgo < 60) return `${secondsAgo}s ago`;
	return `${Math.round(secondsAgo / 60)}m ago`;
};

export const formatZones = (zones: readonly ZoneResult[]): string => {
	if (!zones || zones.length === 0) return '';

	const lines = zones.map(z => {
		const color = z.percent >= 90 ? '🔴' : z.percent >= 75 ? '🟠' : '🟢';
		return `${color} **${z.name}**: ${z.occupied}/${z.total} (${z.percent}%)`;
	});

	return `\n**Zones:**\n${lines.join('\n')}\n`;
};

export const formatTime = (date: Date): string => {
	const formatter = new Intl.DateTimeFormat('en-AU', {
		timeZone: TIMEZONE,
		hour: 'numeric',
		minute: 'numeric',
		hour12: true,
	});
	return formatter.format(date).toLowerCase().replace(' ', '');
};

export const formatDecimalHour = (hour: number): string => {
	const h = Math.floor(hour);
	const m = Math.round((hour % 1) * 60);
	const ampm = h >= 12 ? 'pm' : 'am';
	const h12 = h % 12 || 12;
	return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
};
