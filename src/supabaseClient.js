import { createClient } from '@supabase/supabase-js'

// Publishable key — safe to ship in frontend code by design.
// All real access control lives in Row Level Security on the database.
export const supabase = createClient(
  'https://lsleazpkzdjomgtutlbh.supabase.co',
  'sb_publishable_kqUVq6zM8-W8P-OdnDCO2A_8DGVf0P6'
)
