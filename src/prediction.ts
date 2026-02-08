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

const getBaselineForHour = (historical: HistoricalData | null, hour: number): number => {
	const roundedHour = Math.floor(hour * 2) / 2;
	const hourKey = String(roundedHour);

	if (historical?.[hourKey]?.avg) {
		return historical[hourKey].avg;
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

		const baselineNow = getBaselineForHour(historical, currentHour);
		const baselineAtArrival = getBaselineForHour(historical, arrivalHour);

		const todayFactor = baselineNow > 0 ? currentFillPercent / baselineNow : 1;
		const predictedFill = Math.min(100, baselineAtArrival * todayFactor);

		return {
			predictedFill: Math.round(predictedFill),
			todayFactor,
			confidence: historical ? ('high' as const) : ('low' as const),
			baselineNow,
			baselineAtArrival,
		};
	});

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
