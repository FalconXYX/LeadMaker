// Follow-ups (tasks): the /tasks page and the pieces other features embed (log a call, add a follow-up, a task list).
export { TasksPage, type TasksTab } from './TasksPage';
export { LogActivityDialog, type LogActivityDialogProps } from './LogActivityDialog';
export { TaskQuickAdd, type TaskQuickAddProps } from './TaskQuickAdd';
export { TaskList, type TaskListProps } from './TaskList';
export {
  taskKeys, useTasks, useInfiniteTasks, useTaskCounts, useCompleteTask, useRescheduleTask, useDeleteTask, useCreateTask,
  invalidateAfterTaskWrite, type TaskListParams, type TaskCounts,
} from './queries';
export type { ActivityKind as ActivityType, Task, TaskDue, TaskScope, TaskStatus, TaskType } from './api';
export { TaskTypeIcon } from './parts';
export { TasksPage as default } from './TasksPage';
