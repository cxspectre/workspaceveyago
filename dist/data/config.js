/* Supabase credentials for the Veyago Workspace.
 *
 * Same project as veyago.cloud/admin — the workspace is a second front end onto
 * the one database, not a second database. The anon key is PUBLIC-SAFE by
 * design: Row Level Security is the boundary, and every workspace table is
 * private (no anonymous policy at all), so this key on its own opens nothing.
 * Signing in is what grants access, and employees.role decides how much.
 *
 * Verified on 2026-09-11: anon can read none of crm_companies, support_tickets,
 * client_projects, mail_threads or workspace_activity. See
 * veyagocloud/supabase/tests/.
 */
window.VEYAGO_SUPABASE = {
  url: 'https://vtbvhhilucxroqoaohjb.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0YnZoaGlsdWN4cm9xb2FvaGpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk5OTEsImV4cCI6MjA5ODMxNTk5MX0.I36napRm3WV1yU-2ujRojyO7BRCrXWHTPKM4HNWnTL4'
};
