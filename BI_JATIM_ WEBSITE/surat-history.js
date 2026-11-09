async function simpanSurat({ judul, jenisSurat, isiSurat }) {
  const { data: { user }, error: userError } =
    await supabase.auth.getUser();

  if (userError) {
    throw userError;
  }

  if (!user) {
    alert("Silakan masuk terlebih dahulu untuk menyimpan riwayat surat.");
    return;
  }

  const { error } = await supabase
    .from("surat_history")
    .insert({
      user_id: user.id,
      judul,
      jenis_surat: jenisSurat,
      isi_surat: isiSurat
    });

  if (error) {
    console.error("Gagal menyimpan surat:", error);
    alert("Surat belum berhasil disimpan. Coba lagi.");
    return;
  }

  alert("Surat berhasil disimpan ke riwayat.");
}
