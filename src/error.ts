import { Data } from 'effect';

export class ApiError extends Data.TaggedError('ApiError')<{ service: string; reason: string }> {}
export class ConfigError extends Data.TaggedError('ConfigError')<{ key: string }> {}
