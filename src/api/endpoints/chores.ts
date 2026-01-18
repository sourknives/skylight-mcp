import { getClient } from "../client.js";
import type {
  ChoresResponse,
  ChoreResponse,
  ChoreResource,
  CategoryResource,
} from "../types.js";

export interface GetChoresOptions {
  after?: string;
  before?: string;
  includeLate?: boolean;
  filterLinkedToProfile?: boolean;
}

export interface GetChoresResult {
  chores: ChoreResource[];
  categories: CategoryResource[];
}

/**
 * Get chores for a date range
 */
export async function getChores(options: GetChoresOptions = {}): Promise<GetChoresResult> {
  const client = getClient();
  const params: Record<string, string | boolean | undefined> = {
    after: options.after,
    before: options.before,
    include_late: options.includeLate,
  };

  if (options.filterLinkedToProfile) {
    params.filter = "linked_to_profile";
  }

  const response = await client.get<ChoresResponse>(
    "/api/frames/{frameId}/chores",
    params
  );

  return {
    chores: response.data,
    categories: response.included ?? [],
  };
}

export interface CreateChoreOptions {
  summary: string;
  start: string;
  startTime?: string;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string;
  categoryId?: string;
  rewardPoints?: number;
  emojiIcon?: string;
}

/**
 * Create a new chore
 * Note: Uses the create_multiple endpoint with a single chore
 */
export async function createChore(options: CreateChoreOptions): Promise<ChoreResource> {
  const client = getClient();

  // API expects flat JSON structure, not JSON:API format
  const request: Record<string, unknown> = {
    summary: options.summary,
    start: options.start,
    start_time: options.startTime ?? null,
    status: options.status ?? "pending",
    recurring: options.recurring ?? false,
    recurrence_set: options.recurrenceSet ? [options.recurrenceSet] : null,
    reward_points: options.rewardPoints ?? null,
    emoji_icon: options.emojiIcon ?? null,
  };

  // Add category_id if provided (API uses category_id, not nested relationships)
  if (options.categoryId) {
    request.category_id = options.categoryId;
    request.category_ids = [options.categoryId];
  }

  // Use create_multiple endpoint (there's no single-create endpoint)
  const response = await client.post<ChoresResponse>(
    "/api/frames/{frameId}/chores/create_multiple",
    request
  );

  // Return the first (and only) created chore
  return response.data[0];
}

export interface UpdateChoreOptions {
  summary?: string;
  start?: string;
  startTime?: string | null;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string | null;
  categoryId?: string | null;
  rewardPoints?: number | null;
  emojiIcon?: string | null;
}

/**
 * Update an existing chore
 */
export async function updateChore(
  choreId: string,
  options: UpdateChoreOptions
): Promise<ChoreResource> {
  const client = getClient();

  // API expects flat JSON structure, not JSON:API format
  const request: Record<string, unknown> = {};

  // Map options to flat request body
  if (options.summary !== undefined) request.summary = options.summary;
  if (options.start !== undefined) request.start = options.start;
  if (options.startTime !== undefined) request.start_time = options.startTime;
  if (options.status !== undefined) request.status = options.status;
  if (options.recurring !== undefined) request.recurring = options.recurring;
  if (options.recurrenceSet !== undefined) {
    request.recurrence_set = options.recurrenceSet ? [options.recurrenceSet] : null;
  }
  if (options.rewardPoints !== undefined) request.reward_points = options.rewardPoints;
  if (options.emojiIcon !== undefined) request.emoji_icon = options.emojiIcon;

  // Handle category_id (API uses category_id, not nested relationships)
  if (options.categoryId !== undefined) {
    request.category_id = options.categoryId;
    if (options.categoryId !== null) {
      request.category_ids = [options.categoryId];
    }
  }

  const response = await client.request<ChoreResponse>(
    `/api/frames/{frameId}/chores/${choreId}`,
    { method: "PUT", body: request }
  );

  return response.data;
}

/**
 * Delete a chore
 */
export async function deleteChore(choreId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${choreId}`, {
    method: "DELETE",
  });
}
