import { getClient } from "../client.js";
import type {
  RewardsResponse,
  RewardResource,
  RewardResponse,
  RewardPointsResponse,
  RewardPointResource,
} from "../types.js";

export interface GetRewardsOptions {
  redeemedAtMin?: string;
}

/**
 * Get rewards (items that can be redeemed with points)
 */
export async function getRewards(options: GetRewardsOptions = {}): Promise<RewardResource[]> {
  const client = getClient();
  const response = await client.get<RewardsResponse>(
    "/api/frames/{frameId}/rewards",
    {
      redeemed_at_min: options.redeemedAtMin,
    }
  );
  return response.data;
}

/**
 * Get reward points for family members
 */
export async function getRewardPoints(): Promise<RewardPointResource[]> {
  const client = getClient();
  const response = await client.get<RewardPointsResponse>(
    "/api/frames/{frameId}/reward_points"
  );
  return response.data;
}

export interface CreateRewardOptions {
  name: string;
  pointValue: number;
  description?: string;
  emojiIcon?: string;
  categoryIds?: string[];
  respawnOnRedemption?: boolean;
}

/**
 * Create a new reward
 * Note: The Skylight API uses flat JSON format for rewards, not JSON:API
 */
export async function createReward(options: CreateRewardOptions): Promise<RewardResource> {
  const client = getClient();

  // API expects flat JSON format, not JSON:API
  const request: Record<string, unknown> = {
    name: options.name,
    point_value: options.pointValue,
    respawn_on_redemption: options.respawnOnRedemption ?? false,
  };

  // Only include optional fields if provided
  if (options.description !== undefined) {
    request.description = options.description;
  }
  if (options.emojiIcon !== undefined) {
    request.emoji_icon = options.emojiIcon;
  }
  if (options.categoryIds && options.categoryIds.length > 0) {
    request.category_ids = options.categoryIds;
  }

  const response = await client.post<RewardResponse>("/api/frames/{frameId}/rewards", request);
  // API returns data as an array when creating with category_ids
  const data = response.data;
  return Array.isArray(data) ? data[0] : data;
}

export interface UpdateRewardOptions {
  name?: string;
  pointValue?: number;
  description?: string | null;
  emojiIcon?: string | null;
  categoryId?: string; // Note: API uses singular category_id for updates
  respawnOnRedemption?: boolean;
}

/**
 * Update an existing reward
 * Note: The Skylight API uses flat JSON format for rewards, not JSON:API
 */
export async function updateReward(
  rewardId: string,
  options: UpdateRewardOptions
): Promise<RewardResource> {
  const client = getClient();

  // API expects flat JSON format, not JSON:API
  const request: Record<string, unknown> = {};

  if (options.name !== undefined) request.name = options.name;
  if (options.pointValue !== undefined) request.point_value = options.pointValue;
  if (options.description !== undefined) request.description = options.description;
  if (options.emojiIcon !== undefined) request.emoji_icon = options.emojiIcon;
  if (options.respawnOnRedemption !== undefined) {
    request.respawn_on_redemption = options.respawnOnRedemption;
  }
  if (options.categoryId !== undefined) {
    request.category_id = options.categoryId;
  }

  const response = await client.request<RewardResponse>(
    `/api/frames/{frameId}/rewards/${rewardId}`,
    { method: "PATCH", body: request }
  );
  return response.data;
}

/**
 * Delete a reward
 */
export async function deleteReward(rewardId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/rewards/${rewardId}`, {
    method: "DELETE",
  });
}

/**
 * Redeem a reward (spend points)
 */
export async function redeemReward(
  rewardId: string,
  categoryId?: string
): Promise<RewardResource> {
  const client = getClient();
  const body = categoryId ? { category_id: categoryId } : {};
  const response = await client.post<RewardResponse>(
    `/api/frames/{frameId}/rewards/${rewardId}/redeem`,
    body
  );
  return response.data;
}

/**
 * Unredeem a reward (cancel redemption)
 */
export async function unredeemReward(rewardId: string): Promise<RewardResource> {
  const client = getClient();
  const response = await client.post<RewardResponse>(
    `/api/frames/{frameId}/rewards/${rewardId}/unredeem`,
    {}
  );
  return response.data;
}
