import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import { CarparkResponse, parseOccupancy } from '../src/transport';

describe('CarparkResponse Schema', () => {
	it('validates response with null occupancy values', () => {
		const json = {
			tsn: "207210",
			time: "823851575",
			spots: "213",
			zones: [
				{
					spots: "213",
					zone_id: "1",
					occupancy: {
						loop: null,
						total: "17",
						monthlies: null,
						open_gate: null,
						transients: null
					},
					zone_name: "Park&Ride - Gordon Henry St (north)",
					parent_zone_id: "0"
				}
			],
			ParkID: "1",
			location: {
				suburb: "Gordon",
				address: "Henry Street",
				latitude: "-33.757065",
				longitude: "151.154662"
			},
			occupancy: {
				loop: null,
				total: "17",
				monthlies: null,
				open_gate: null,
				transients: null
			},
			MessageDate: "2026-02-08T18:39:35",
			facility_id: "6",
			facility_name: "Park&Ride - Gordon Henry St (north)",
			tfnsw_facility_id: "207210TPR001"
		};

		const result = Schema.decodeUnknownSync(CarparkResponse)(json);
		expect(result).toBeDefined();
		expect(result.occupancy.total).toBe("17");
		expect(result.occupancy.loop).toBeNull();
		expect(result.occupancy.transients).toBeNull();
	});

	it('validates response with missing occupancy values', () => {
		const json = {
			facility_id: "6",
			facility_name: "Test",
			spots: "100",
			occupancy: {}
		};
		const result = Schema.decodeUnknownSync(CarparkResponse)(json);
		expect(result).toBeDefined();
		expect(result.occupancy.total).toBeUndefined();
	});
});

describe('parseOccupancy', () => {
	it('parses total when present', () => {
		const data = { occupancy: { total: "10", loop: null, transients: null } };
		expect(parseOccupancy(data)).toBe(10);
	});

	it('parses loop when total is null', () => {
		const data = { occupancy: { total: null, loop: "5", transients: null } };
		expect(parseOccupancy(data)).toBe(5);
	});

	it('parses transients when total and loop are null', () => {
		const data = { occupancy: { total: null, loop: null, transients: "3" } };
		expect(parseOccupancy(data)).toBe(3);
	});

	it('returns 0 when all are null', () => {
		const data = { occupancy: { total: null, loop: null, transients: null } };
		expect(parseOccupancy(data)).toBe(0);
	});

	it('returns 0 when all are undefined', () => {
		const data = { occupancy: {} };
		expect(parseOccupancy(data)).toBe(0);
	});
});
