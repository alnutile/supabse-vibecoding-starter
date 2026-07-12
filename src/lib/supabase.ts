import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Fail loudly in dev if the env isn't wired — see .env.example.
  console.warn(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill in your project values.',
  )
}

// Both values are PUBLIC and safe in VITE_ vars. The service_role key must
// NEVER appear here or in any client code.
export const supabase = createClient(url ?? '', anonKey ?? '')

// The private Storage bucket the starter uploads to. Its RLS policies scope
// every object to a top-level folder named with the owner's uid.
export const DOCUMENTS_BUCKET = 'documents'
