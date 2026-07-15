package co.callora.mobile.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.sqlite.db.SupportSQLiteDatabase

class QueueConverters {
    @TypeConverter
    fun fromStatus(value: QueueStatus): String = value.name

    @TypeConverter
    fun toStatus(value: String): QueueStatus = QueueStatus.valueOf(value)
}

@Database(
    entities = [QueuedCallEntity::class],
    version = 1,
    exportSchema = true,
)
@TypeConverters(QueueConverters::class)
abstract class CalloraDatabase : RoomDatabase() {
    abstract fun queuedCalls(): QueuedCallDao

    companion object {
        fun create(context: Context): CalloraDatabase = Room.databaseBuilder(
            context.applicationContext,
            CalloraDatabase::class.java,
            "callora_queue.db",
        )
            .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
            .addCallback(object : RoomDatabase.Callback() {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    // `secure_delete` returns a result row on newer SQLite builds, so
                    // Android rejects it through execSQL(). Querying works across the
                    // supported API range and still applies the connection pragma.
                    db.query("PRAGMA secure_delete=ON").close()
                }
            })
            .build()
    }
}
