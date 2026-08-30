export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  column_id: string;
  priority: number | null;
  assignee: string | null;
  estimate: number | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived_at: number | null;
}

export interface NewTask {
  title: string;
  description?: string | null;
  column_id?: string | null;
  priority?: number | null;
  assignee?: string | null;
  estimate?: number | null;
  due_at?: number | null;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  priority?: number | null;
  assignee?: string | null;
  estimate?: number | null;
  due_at?: number | null;
}
