export const TIMEZONE = 'Australia/Sydney';

export interface SydneyTime {
	date: Date;
	dayOfWeek: string;
	shortDay: string;
	hour: number;
	minute: number;
	timeString: string;
}

export const getSydneyTime = (): SydneyTime => {
	const now = new Date();

	const formatter = new Intl.DateTimeFormat('en-AU', {
		timeZone: TIMEZONE,
		weekday: 'long',
		hour: 'numeric',
		minute: 'numeric',
		hour12: false,
	});

	const parts = formatter.formatToParts(now);
	const getPart = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find(p => p.type === type)?.value || '';

	const dayOfWeek = getPart('weekday');
	const hour = parseInt(getPart('hour'), 10);
	const minute = parseInt(getPart('minute'), 10);

	return {
		date: now,
		dayOfWeek,
		shortDay: dayOfWeek.substring(0, 3),
		hour,
		minute,
		timeString: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
	};
};

export const isWeekday = (day: string): boolean => {
	return !['Saturday', 'Sunday'].includes(day);
};

export const isValidTimeFormat = (time: string): boolean => {
	return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
};

export const isValidDayFormat = (days: string): boolean => {
	const validDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	const parts = days.split(',').map(d => d.trim());

	if (parts.length === 0) return false;

	return parts.every(d => validDays.includes(d));
};
