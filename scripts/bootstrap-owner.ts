import { loadEnvConfig } from '@next/env';
import { createClient } from '@supabase/supabase-js';

loadEnvConfig(process.cwd());

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.BOOTSTRAP_OWNER_EMAIL;
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!url || !serviceKey || !email || !password) {
    throw new Error('Supabase and bootstrap owner variables are required.');
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: users, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const existing = users.users.find(user => user.email?.toLowerCase() === email.toLowerCase());
  const result = existing
    ? await admin.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
        user_metadata: { display_name: 'Demo Owner' },
      })
    : await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: 'Demo Owner' },
      });
  if (result.error) throw result.error;
  console.log(JSON.stringify({ created: !existing, userId: result.data.user.id, email }));
}

main().catch(error => {
  console.error(JSON.stringify({ created: false, message: error instanceof Error ? error.message : 'Owner bootstrap failed.' }));
  process.exitCode = 1;
});
