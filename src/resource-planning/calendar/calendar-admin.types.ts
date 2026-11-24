export interface WorkloadSchemeRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  monday_hours: number;
  tuesday_hours: number;
  wednesday_hours: number;
  thursday_hours: number;
  friday_hours: number;
  saturday_hours: number;
  sunday_hours: number;
  is_default: boolean;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkloadSchemeMemberRow {
  id: string;
  organization_id: string;
  scheme_id: string;
  user_id: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface HolidaySchemeRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface HolidaySchemeDayRow {
  id: string;
  organization_id: string;
  scheme_id: string;
  name: string;
  description: string | null;
  recurrence: 'fixed_annual' | 'one_off';
  month: number | null;
  day: number | null;
  holiday_date: string | null;
  duration_days: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface HolidaySchemeMemberRow {
  id: string;
  organization_id: string;
  scheme_id: string;
  user_id: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
