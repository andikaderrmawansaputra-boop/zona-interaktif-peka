async function muatRiwayatSurat() {
  const { data: { user }, error: userError } =
    await supabase.auth.getUser();

  if (userError || !user) return [];

  const { data, error } = await supabase
    .from("surat_history")
    .select("id, judul, jenis_surat, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Gagal memuat riwayat:", error);
    return [];
  }

  return data;
}
