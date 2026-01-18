import { getClient } from "../client.js";
import type {
  TaskBoxItemResponse,
  TaskBoxItemResource,
  TaskBoxItemsResponse,
  CreateTaskBoxItemRequest,
  UpdateTaskBoxItemRequest,
} from "../types.js";

export interface CreateTaskBoxItemOptions {
  summary: string;
  emojiIcon?: string;
  routine?: boolean;
  rewardPoints?: number;
}

/**
 * Create a task box item
 * Task box items are unscheduled tasks that can later be assigned to specific dates
 */
export async function createTaskBoxItem(
  options: CreateTaskBoxItemOptions
): Promise<TaskBoxItemResource> {
  const client = getClient();

  const request: CreateTaskBoxItemRequest = {
    data: {
      type: "task_box_item",
      attributes: {
        summary: options.summary,
        emoji_icon: options.emojiIcon ?? null,
        routine: options.routine ?? false,
        reward_points: options.rewardPoints ?? null,
      },
    },
  };

  const response = await client.post<TaskBoxItemResponse>(
    "/api/frames/{frameId}/task_box/items",
    request
  );

  return response.data;
}

/**
 * Get all task box items
 */
export async function getTaskBoxItems(): Promise<TaskBoxItemResource[]> {
  const client = getClient();
  const response = await client.get<TaskBoxItemsResponse>(
    "/api/frames/{frameId}/task_box/items"
  );
  return response.data;
}

export interface UpdateTaskBoxItemOptions {
  summary?: string;
  emojiIcon?: string | null;
  routine?: boolean;
  rewardPoints?: number | null;
}

/**
 * Update a task box item
 */
export async function updateTaskBoxItem(
  itemId: string,
  options: UpdateTaskBoxItemOptions
): Promise<TaskBoxItemResource> {
  const client = getClient();

  const request: UpdateTaskBoxItemRequest = {
    data: {
      type: "task_box_item",
      attributes: {},
    },
  };

  if (options.summary !== undefined) request.data.attributes.summary = options.summary;
  if (options.emojiIcon !== undefined) request.data.attributes.emoji_icon = options.emojiIcon;
  if (options.routine !== undefined) request.data.attributes.routine = options.routine;
  if (options.rewardPoints !== undefined) request.data.attributes.reward_points = options.rewardPoints;

  const response = await client.request<TaskBoxItemResponse>(
    `/api/frames/{frameId}/task_box/items/${itemId}`,
    { method: "PUT", body: request }
  );

  return response.data;
}

/**
 * Delete a task box item
 */
export async function deleteTaskBoxItem(itemId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/task_box/items/${itemId}`, {
    method: "DELETE",
  });
}
