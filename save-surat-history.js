async function simpanRiwayatSurat() {
  const { data: { user }, error: userError } =
    await supabase.auth.getUser();

  if (userError || !user) {
    alert("Silakan masuk terlebih dahulu untuk menyimpan riwayat surat.");
    return;
  }

  const surat = {
    user_id: user.id,
    nama_lengkap: document.getElementById("namaLengkap").value.trim(),
    nik: document.getElementById("nik").value.trim(),
    alamat_domisili: document.getElementById("alamatDomisili").value.trim(),
    alamat_ktp: document.getElementById("alamatKtp").value.trim(),
    no_hp: document.getElementById("noHp").value.trim(),
    email: document.getElementById("email").value.trim(),
    perihal_surat: document.getElementById("perihalSurat").value.trim(),
    nama_pujk: document.getElementById("namaPujk").value.trim(),
    kronologi: document.getElementById("kronologi").value.trim(),
    kota_penandatanganan: document.getElementById("kotaPenandatanganan").value.trim(),
    tanggal_surat: document.getElementById("tanggalSurat").value
  };

  if (!/^\d{16}$/.test(surat.nik)) {
    alert("NIK harus terdiri dari 16 angka.");
    return;
  }

  const { error } = await supabase
    .from("surat_history")
    .insert(surat);

  if (error) {
    console.error("Gagal menyimpan riwayat surat:", error);
    alert("Riwayat surat belum berhasil disimpan.");
    return;
  }

  alert("Riwayat surat berhasil disimpan.");
}
