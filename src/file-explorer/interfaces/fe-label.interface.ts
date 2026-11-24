export interface IFeLabel {
  id: string;
  space_id: string;
  organization_id: string;
  name: string;
  color: string;
  created_by: string | null;
  created_at: string;
}

export interface IFeReminder {
  id: string;
  node_id: string;
  user_id: string;
  organization_id: string;
  remind_at: string;
  message: string | null;
  reminder_type: 'email' | 'in_app' | 'both';
  is_sent: boolean;
  sent_at: string | null;
  created_at: string;
}
