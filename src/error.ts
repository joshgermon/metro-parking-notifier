import { Data } from 'effect';

export class ApiError extends Data.TaggedError('ApiError')<{ service: string; reason: string }> {}
export class NotificationError extends Data.TaggedError('NotificationError')<{ userId: string; reason: string }> {}
