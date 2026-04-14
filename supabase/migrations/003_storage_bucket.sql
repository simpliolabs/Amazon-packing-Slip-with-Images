-- Create product-images storage bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  false,
  5242880, -- 5MB limit per image
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- Storage RLS: authenticated users can read product images
create policy "Authenticated users can read product images"
  on storage.objects for select
  using (
    bucket_id = 'product-images'
    and auth.role() = 'authenticated'
  );

-- Service role can manage product images
create policy "Service role can manage product images"
  on storage.objects for all
  using (
    bucket_id = 'product-images'
    and auth.role() = 'service_role'
  );
