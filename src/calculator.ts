import { Effect, Schema } from 'effect';
import { checkParking, getStationsConfig, type FillRate, type ZoneResult } from './transport';
import { checkTraffic } from './traffic';
import { predictFillAtArrival, estimateFullTime, estimateFullTimeFromRate, getHistoricalLeaveByTime, getDeviationFromBaseline } from './prediction';
import { getSydneyTime, type SydneyTime } from './time';
import { formatTime } from './format';
import { ApiError } from './error';

export const UserPrefs = Schema.Struct({
	home: Schema.String,
	station: Schema.String,
	days: Schema.String,
	arrival: Schema.String,
	notificationStart: Schema.String,
	buffer: Schema.Number,
	userId: Schema.String,
	preferredZone: Schema.optional(Schema.String),
});

export type UserPrefs = Schema.Schema.Type<typeof UserPrefs>;

export interface LeaveByResult {
	leaveByTime: Date;
	leaveByFormatted: string;
	stationName: string;
	currentFill: number;
	predictedFill: number;
	freeSpots: number;
	totalSpots: number;
	travelMinutes: number;
	trafficDelay: number;
	estimatedFullTime: number | null;
	confidence: 'high' | 'low';
	zoneName: string | null;
	fillRate: FillRate | null;
	alternatives: {
		name: string;
		currentPercent: number;
		freeSpots: number;
		estimatedFullTime: number | null;
	}[];
	allZones: ZoneResult[];
	deviation: number;
	baselineFill: number;
	historicalLeaveByDecimal: number | null;
}

const parseTrafficDuration = (text: string): number => {
	const hours = text.match(/(\d+)\s*hour/)?.[1] ?? 0;
	const mins = text.match(/(\d+)\s*min/)?.[1] ?? 0;
	return Number(hours) * 60 + Number(mins);
};

const earliestFullTime = (a: number | null, b: number | null): number | null => {
	if (a !== null && b !== null) return Math.min(a, b);
	return a ?? b;
};

export const calculateLeaveBy = (prefs: UserPrefs, env: Env, sydneyTime?: SydneyTime) =>
	Effect.gen(function* () {
		const sydney = sydneyTime || getSydneyTime();
		const dayOfWeek = sydney.dayOfWeek;

		const [arrivalHour, arrivalMin] = prefs.arrival.split(':').map(Number);

		const currentTotalMinutes = sydney.hour * 60 + sydney.minute;
		const arrivalTotalMinutes = arrivalHour * 60 + arrivalMin;
		let minutesUntil = arrivalTotalMinutes - currentTotalMinutes;

		if (minutesUntil < -60) {
			minutesUntil += 24 * 60;
		}

		const arrivalTime = new Date(sydney.date.getTime() + minutesUntil * 60 * 1000);

		const parking = yield* checkParking(prefs.station, env);

		const config = yield* getStationsConfig(env);
		const stationData = config.stations[prefs.station];

		if (!stationData) {
			return yield* Effect.fail(new ApiError({ service: 'Calculator', reason: `Unknown station: ${prefs.station}` }));
		}

		const dest = `${stationData.location.lat},${stationData.location.lng}`;
		const traffic = yield* checkTraffic(prefs.home, dest, env.GOOGLE_MAPS_API_KEY);

		const travelMinutes = parseTrafficDuration(traffic.text);
		const currentHour = sydney.hour + sydney.minute / 60;
		const arrivalHourDecimal = arrivalHour + arrivalMin / 60;

		const preferredZone = prefs.preferredZone
			? parking.zones.find(z => z.name.toLowerCase() === prefs.preferredZone!.toLowerCase())
			: null;

		const targetPercent = preferredZone ? preferredZone.percent : parking.percent;
		const targetFree = preferredZone ? (preferredZone.total - preferredZone.occupied) : parking.free;
		const targetTotal = preferredZone ? preferredZone.total : parking.total;
		const targetFillRate = preferredZone ? (preferredZone.fillRate ?? parking.fillRate) : parking.fillRate;
		const targetName = preferredZone ? preferredZone.name : null;

		const predictionKey = preferredZone
			? `${parking.name}::${preferredZone.name}`
			: parking.name;

		// Get predicted fill at arrival using P90-based prediction
		const prediction = yield* predictFillAtArrival(
			{
				currentFillPercent: targetPercent,
				currentHour,
				arrivalHour: arrivalHourDecimal,
				station: predictionKey,
				dayOfWeek,
			},
			env,
		);

		// Get current deviation from P90 baseline
		const { deviation, baseline: baselineFill } = yield* getDeviationFromBaseline(
			predictionKey, dayOfWeek, currentHour, targetPercent, env,
		);

		// Get the stable historical leave-by time from the P90 curve
		const historicalLeaveBy = yield* getHistoricalLeaveByTime(
			predictionKey, dayOfWeek, travelMinutes, prefs.buffer, env,
		);

		// Also compute estimated full time for display purposes
		const historicalFullTime = yield* estimateFullTime(targetPercent, currentHour, predictionKey, dayOfWeek, env);
		const fillRateFullTime = estimateFullTimeFromRate(targetPercent, targetTotal, targetFillRate, currentHour);
		const estimatedFull = earliestFullTime(historicalFullTime, fillRateFullTime);

		// Calculate leave-by time:
		// Primary: use the stable P90 historical curve leave-by time
		// If today is tracking worse than P90, add extra padding proportional to the deviation
		let leaveByTime: Date;
		let historicalLeaveByDecimal: number | null = null;

		if (historicalLeaveBy) {
			historicalLeaveByDecimal = historicalLeaveBy.leaveByDecimal;
			let leaveByDecimal = historicalLeaveBy.leaveByDecimal;

			// If today is significantly above P90, add extra padding
			// Each percentage point above P90 ≈ 1 minute earlier departure
			if (deviation > 0) {
				leaveByDecimal -= deviation / 60;
			}

			// Convert decimal hours to a Date
			const leaveByMinutesFromMidnight = leaveByDecimal * 60;
			const startOfDay = new Date(sydney.date);
			startOfDay.setHours(0, 0, 0, 0);
			// Adjust for Sydney timezone offset
			const utcMidnight = startOfDay.getTime();
			const sydneyOffset = sydney.hour * 60 + sydney.minute - (startOfDay.getUTCHours() * 60 + startOfDay.getUTCMinutes());
			leaveByTime = new Date(utcMidnight + (leaveByMinutesFromMidnight - sydneyOffset + currentTotalMinutes) * 60 * 1000);
			// Simpler: calculate from current time
			const leaveByMins = leaveByDecimal * 60;
			const minsFromNow = leaveByMins - currentTotalMinutes;
			leaveByTime = new Date(sydney.date.getTime() + minsFromNow * 60 * 1000);
		} else {
			// No historical data predicts the lot filling — use arrival time minus travel
			leaveByTime = new Date(arrivalTime.getTime() - travelMinutes * 60 * 1000);

			// But if estimated full time exists and is before arrival, adjust
			if (estimatedFull !== null && estimatedFull < arrivalHourDecimal) {
				const mustArriveByDecimal = estimatedFull - prefs.buffer / 60;
				const mustArriveByMinutes = mustArriveByDecimal * 60;
				const minutesUntilMustArrive = mustArriveByMinutes - currentTotalMinutes;
				const mustArriveByTime = new Date(sydney.date.getTime() + minutesUntilMustArrive * 60 * 1000);
				if (mustArriveByTime < arrivalTime) {
					leaveByTime = new Date(mustArriveByTime.getTime() - travelMinutes * 60 * 1000);
				}
			}
		}

		// Ensure leave-by never exceeds the simple "arrival minus travel" time
		const latestLeaveBy = new Date(arrivalTime.getTime() - travelMinutes * 60 * 1000);
		if (leaveByTime > latestLeaveBy) {
			leaveByTime = latestLeaveBy;
		}

		const alternatives = preferredZone
			? yield* Effect.forEach(
				parking.zones.filter(z => z.name.toLowerCase() !== preferredZone.name.toLowerCase()),
				(zone) => {
					const zonePredictionKey = `${parking.name}::${zone.name}`;
					return estimateFullTime(zone.percent, currentHour, zonePredictionKey, dayOfWeek, env).pipe(
						Effect.map((zoneHistoricalFull) => ({
							name: zone.name,
							currentPercent: zone.percent,
							freeSpots: zone.total - zone.occupied,
							estimatedFullTime: earliestFullTime(
								zoneHistoricalFull,
								estimateFullTimeFromRate(zone.percent, zone.total, zone.fillRate ?? null, currentHour),
							),
						})),
					);
				},
			)
			: [];

		return {
			leaveByTime,
			leaveByFormatted: formatTime(leaveByTime),
			stationName: parking.name,
			currentFill: targetPercent,
			predictedFill: prediction.predictedFill,
			freeSpots: targetFree,
			totalSpots: targetTotal,
			travelMinutes,
			trafficDelay: traffic.delay,
			estimatedFullTime: estimatedFull,
			confidence: prediction.confidence,
			zoneName: targetName,
			fillRate: targetFillRate,
			alternatives,
			allZones: parking.zones,
			deviation,
			baselineFill,
			historicalLeaveByDecimal,
		} satisfies LeaveByResult;
	});
