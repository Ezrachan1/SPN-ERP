package com.spn.os;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/* Copied into the Android project by mobile/scripts/patch-android.mjs (edit it there).
   Saves a file into Downloads/SPN OS and posts a "Download complete" notification that
   opens the file when tapped and has a Share action, the way a browser download does. */
@CapacitorPlugin(name = "SpnDownloads")
public class SpnDownloadsPlugin extends Plugin {

    private static final String CHANNEL = "spn_downloads";
    private static final String FOLDER = "SPN OS";
    // notification ids sit clear of the local-notification reminders (1,000,000 to 2,999,999)
    private static final int FIRST_ID = 4000000;
    private static final int LAST_ID = 4999990;

    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        String name = cleanName(call.getString("filename", "file"));
        String mime = call.getString("mimeType");
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        if (data == null) {
            call.reject("No file data");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("The file data could not be read");
            return;
        }
        try {
            Context ctx = getContext();
            Uri uri;
            String saved = name;
            String location;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = ctx.getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("Downloads is not available");
                // whatever goes wrong before the file is finished, no hidden half-written entry stays behind
                boolean finished = false;
                try {
                    try (OutputStream os = cr.openOutputStream(uri)) {
                        if (os == null) throw new IOException("Downloads is not writable");
                        os.write(bytes);
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    if (cr.update(uri, done, null, null) < 1) throw new IOException("Downloads did not finish the file");
                    finished = true;
                } finally {
                    if (!finished) {
                        try { cr.delete(uri, null, null); } catch (Exception ignore) { }
                    }
                }
                // a name already in the folder gets a number added by Android: report the real one
                try (Cursor c = cr.query(uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst() && c.getString(0) != null) saved = c.getString(0);
                }
                location = "Downloads/" + FOLDER;
            } else {
                // before Android 10, the app's own Downloads folder needs no storage permission
                File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), FOLDER);
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("Could not create the downloads folder");
                File f = unique(dir, name);
                try (FileOutputStream os = new FileOutputStream(f)) {
                    os.write(bytes);
                }
                saved = f.getName();
                uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
                location = "SPN OS downloads";
            }
            boolean notified = notifyDone(uri, mime, saved);
            JSObject r = new JSObject();
            r.put("uri", uri.toString());
            r.put("name", saved);
            r.put("mimeType", mime);
            r.put("location", location);
            r.put("notified", notified);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String u = call.getString("uri");
        if (u == null) {
            call.reject("No file");
            return;
        }
        try {
            getActivity().startActivity(viewIntent(Uri.parse(u), call.getString("mimeType", "*/*")));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can open this type of file");
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        String u = call.getString("uri");
        if (u == null) {
            call.reject("No file");
            return;
        }
        try {
            getActivity().startActivity(shareIntent(Uri.parse(u), call.getString("mimeType", "*/*"), call.getString("name", "file")));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can share this file");
        }
    }

    private static Intent viewIntent(Uri uri, String mime) {
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, mime);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    private static Intent shareIntent(Uri uri, String mime, String name) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri(name, uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, "Share " + name);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return chooser;
    }

    private boolean notifyDone(Uri uri, String mime, String name) {
        Context ctx = getContext();
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager sys = ctx.getSystemService(NotificationManager.class);
            if (sys != null && sys.getNotificationChannel(CHANNEL) == null) {
                // high importance: the notification pops up on screen as well as staying in the bar
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Reports, receipts and exports saved by SPN OS");
                sys.createNotificationChannel(ch);
            }
        }
        // the counter survives app restarts, so a new download never replaces an earlier one still in the bar
        int id;
        synchronized (SpnDownloadsPlugin.class) {
            SharedPreferences sp = ctx.getSharedPreferences("spn_downloads", Context.MODE_PRIVATE);
            id = sp.getInt("next_id", FIRST_ID);
            if (id < FIRST_ID || id > LAST_ID) id = FIRST_ID;
            sp.edit().putInt("next_id", id >= LAST_ID ? FIRST_ID : id + 1).commit();
        }
        int flags = PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // a chooser: with no app for the file type the phone says so instead of the tap doing nothing
        Intent pick = Intent.createChooser(viewIntent(uri, mime), "Open " + name);
        pick.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        PendingIntent open = PendingIntent.getActivity(ctx, id * 2, pick, flags);
        PendingIntent share = PendingIntent.getActivity(ctx, id * 2 + 1, shareIntent(uri, mime, name), flags);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(name)
            .setContentText("Download complete · tap to open")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, "Share", share);
        try {
            nm.notify(id, b.build());
            return true;
        } catch (SecurityException e) {
            return false;
        }
    }

    private static String cleanName(String n) {
        String s = (n == null ? "file" : n).replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]+", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "file";
        return s.length() > 120 ? s.substring(s.length() - 120) : s;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + " " + System.currentTimeMillis() + ext);
    }
}
