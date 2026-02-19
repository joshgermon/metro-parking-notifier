import { Effect } from 'effect';
import { getHistoricalData, type HistoricalData } from './history';
import type { FillRate } from './transport';

const BASE_FILL_CURVE: Record<number, number> = {
	5: 10,
	5.5: 15,
	6: 25,
	6.5: 35,
	7: 55,
	7.5: 75,
	8: 88,
	8.5: 94,
	9: 97,
};

type BaselineMode = 'avg' | 'p90';

const getBaselineForHour = (historical: HistoricalData | null, hour: number, mode: BaselineMode = 'p90'): number => {
	const roundedHour = Math.floor(hour * 2) / 2;
	const hourKey = String(roundedHour);

	if (historical?.[hourKey]) {
		const bucket = historical[hourKey];
		if (mode === 'p90' && bucket.p90 > 0) return bucket.p90;
		if (bucket.avg > 0) return bucket.avg;
	}

	return BASE_FILL_CURVE[roundedHour] ?? 50;
};

interface PredictionInput {
	currentFillPercent: number;
	currentHour: number;
	arrivalHour: number;
	station: string;
	dayOfWeek: string;
}

export const predictFillAtArrival = (input: PredictionInput, env: Env) =>
	Effect.gen(function* () {
		const { currentFillPercent, currentHour, arrivalHour, station, dayOfWeek } = input;

		const historical = yield* getHistoricalData(station, dayOfWeek, env);

		// Use P90 as the conservative baseline
		const baselineNow = getBaselineForHour(historical, currentHour, 'p90');
		const baselineAtArrival = getBaselineForHour(historical, arrivalHour, 'p90');

		// If today is tracking below P90, just use the P90 curve as-is (conservative)
		// If today is tracking above P90, scale up proportionally
		const todayFactor = currentFillPercent > baselineNow
			? currentFillPercent / baselineNow
			: 1;
		const predictedFill = Math.min(100, baselineAtArrival * todayFactor);

		return {
			predictedFill: Math.round(predictedFill),
			todayFactor,
			confidence: historical ? ('high' as const) : ('low' as const),
			baselineNow,
			baselineAtArrival,
		};
	});

/**
 * Estimate when the P90 historical curve reaches 95% fill.
 * Steps forward in 15-minute increments from currentHour to 10:00.
 */
export const estimateFullTime = (
	currentFillPercent: number,
	currentHour: number,
	station: string,
	dayOfWeek: string,
	env: Env,
) =>
	Effect.gen(function* () {
		for (let testHour = currentHour; testHour <= 10; testHour += 0.25) {
			const prediction = yield* predictFillAtArrival(
				{
					currentFillPercent,
					currentHour,
					arrivalHour: testHour,
					station,
					dayOfWeek,
				},
				env,
			);

			if (prediction.predictedFill >= 95) {
				return testHour;
			}
		}

		return null;
	});

export const estimateFullTimeFromRate = (
	currentPercent: number,
	totalSpots: number,
	fillRate: FillRate | null,
	currentHour: number,
	threshold: number = 95,
): number | null => {
	if (!fillRate || fillRate.spotsPerMin <= 0) return null;
	if (currentPercent >= threshold) return currentHour; // Already full
	if (totalSpots <= 0) return null;

	const currentOccupied = (currentPercent / 100) * totalSpots;
	const thresholdOccupied = (threshold / 100) * totalSpots;
	const spotsUntilFull = thresholdOccupied - currentOccupied;
	const minutesUntilFull = spotsUntilFull / fillRate.spotsPerMin;

	return currentHour + minutesUntilFull / 60;
};

/**
 * Get a stable leave-by time based purely on the P90 historical fill curve.
 * Walks the P90 curve to find when it hits 95%, subtracts travel + buffer.
 * Returns the leave-by time as decimal hours, or null if the lot isn't predicted to fill.
 */
export const getHistoricalLeaveByTime = (
	station: string,
	dayOfWeek: string,
	travelMinutes: number,
	buffer: number,
	env: Env,
) =>
	Effect.gen(function* () {
		const historical = yield* getHistoricalData(station, dayOfWeek, env);

		// Walk the P90 curve from 5am to 10am in 15-min steps to find when it hits 95%
		let fullTimeHour: number | null = null;
		for (let testHour = 5; testHour <= 10; testHour += 0.25) {
			const baseline = getBaselineForHour(historical, testHour, 'p90');
			if (baseline >= 95) {
				fullTimeHour = testHour;
				break;
			}
		}

		if (fullTimeHour === null) return null;

		// Subtract buffer and travel time to get leave-by as decimal hours
		const mustArriveBy = fullTimeHour - buffer / 60;
		const leaveByDecimal = mustArriveBy - travelMinutes / 60;

		return { leaveByDecimal, fullTimeHour, confidence: historical ? ('high' as const) : ('low' as const) };
	});

/**
 * Get how far today's fill deviates from the P90 baseline at the current hour.
 * Positive = today is worse than P90, negative = today is better.
 */
export const getDeviationFromBaseline = (
	station: string,
	dayOfWeek: string,
	currentHour: number,
	currentFillPercent: number,
	env: Env,
) =>
	Effect.gen(function* () {
		const historical = yield* getHistoricalData(station, dayOfWeek, env);
		const baseline = getBaselineForHour(historical, currentHour, 'p90');

		return {
			deviation: currentFillPercent - baseline,
			baseline,
			hasHistoricalData: historical !== null,
		};
	});
