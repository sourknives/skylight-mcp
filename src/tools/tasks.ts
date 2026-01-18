import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createTaskBoxItem,
  getTaskBoxItems,
  updateTaskBoxItem,
  deleteTaskBoxItem,
} from "../api/endpoints/taskbox.js";
import { formatErrorForMcp } from "../utils/errors.js";

export function registerTaskTools(server: McpServer): void {
  // get_tasks tool
  server.tool(
    "get_tasks",
    `Get all tasks from the Skylight task box.

The task box holds unscheduled tasks that can later be assigned to specific dates.

Use this to answer:
- "What's in my task box?"
- "Show me my tasks"
- "What tasks do I have?"

Returns tasks with their descriptions, emoji icons, and reward points.`,
    {},
    async () => {
      try {
        const tasks = await getTaskBoxItems();

        if (tasks.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No tasks in the task box.",
              },
            ],
          };
        }

        const taskList = tasks
          .map((task) => {
            const attrs = task.attributes;
            const parts = [`- ${attrs.summary} (ID: ${task.id})`];

            if (attrs.emoji_icon) {
              parts.push(`  Emoji: ${attrs.emoji_icon}`);
            }

            if (attrs.reward_points) {
              parts.push(`  Reward points: ${attrs.reward_points}`);
            }

            if (attrs.routine) {
              parts.push(`  Routine: Yes`);
            }

            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Task Box:\n\n${taskList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // create_task tool
  server.tool(
    "create_task",
    `Add a task to the Skylight task box.

The task box holds unscheduled tasks that can later be assigned to specific dates.

Use this when the user says:
- "Add XYZ to my task list"
- "Remind me to do ABC" (without a specific date)
- "Put 'clean garage' on the task box"

The task will appear on the Skylight display in the task box.`,
    {
      summary: z.string().describe("Task description"),
      emoji: z
        .string()
        .optional()
        .describe("Emoji icon for the task (e.g., '🧹', '📞')"),
      rewardPoints: z
        .number()
        .optional()
        .describe("Reward points for completing this task (for gamification)"),
      routine: z
        .boolean()
        .optional()
        .default(false)
        .describe("Is this a routine task?"),
    },
    async ({ summary, emoji, rewardPoints, routine }) => {
      try {
        const task = await createTaskBoxItem({
          summary,
          emojiIcon: emoji,
          rewardPoints,
          routine: routine ?? false,
        });

        const parts = [`Created task: "${task.attributes.summary}"`];

        if (task.attributes.emoji_icon) {
          parts.push(`Emoji: ${task.attributes.emoji_icon}`);
        }

        if (task.attributes.reward_points) {
          parts.push(`Reward points: ${task.attributes.reward_points}`);
        }

        parts.push(`\nThe task has been added to the Skylight task box.`);

        return {
          content: [
            {
              type: "text" as const,
              text: parts.join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // update_task tool
  server.tool(
    "update_task",
    `Update an existing task in the Skylight task box.

Use this when:
- Changing a task's description
- Adding or changing an emoji icon
- Updating reward points

Parameters:
- taskId (required): ID of the task to update (from get_tasks)
- summary: New description for the task
- emoji: New emoji icon (or null to clear)
- rewardPoints: New reward points (or null to clear)
- routine: Is this a routine task?

Returns: The updated task details.`,
    {
      taskId: z.string().describe("ID of the task to update"),
      summary: z.string().optional().describe("New task description"),
      emoji: z.string().nullable().optional().describe("Emoji icon (or null to clear)"),
      rewardPoints: z.number().nullable().optional().describe("New reward points (or null to clear)"),
      routine: z.boolean().optional().describe("Is this a routine task?"),
    },
    async ({ taskId, summary, emoji, rewardPoints, routine }) => {
      try {
        const updates: Parameters<typeof updateTaskBoxItem>[1] = {};

        if (summary !== undefined) updates.summary = summary;
        if (emoji !== undefined) updates.emojiIcon = emoji;
        if (rewardPoints !== undefined) updates.rewardPoints = rewardPoints;
        if (routine !== undefined) updates.routine = routine;

        const task = await updateTaskBoxItem(taskId, updates);

        return {
          content: [
            {
              type: "text" as const,
              text: `Updated task: "${task.attributes.summary}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // delete_task tool
  server.tool(
    "delete_task",
    `Delete a task from the Skylight task box.

Use this when:
- Removing an old or irrelevant task
- Deleting a task that was added by mistake

Parameters:
- taskId (required): ID of the task to delete (from get_tasks)

Note: This permanently removes the task from the task box.`,
    {
      taskId: z.string().describe("ID of the task to delete"),
    },
    async ({ taskId }) => {
      try {
        await deleteTaskBoxItem(taskId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted task (ID: ${taskId})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
