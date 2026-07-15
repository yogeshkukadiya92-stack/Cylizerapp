package co.callora.mobile.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

class QueueConverters {
    @TypeConverter
    fun fromStatus(value: QueueStatus): String = value.name

    @TypeConverter
    fun toStatus(value: String): QueueStatus = QueueStatus.valueOf(value)

    @TypeConverter
    fun fromLeadMutationStatus(value: LeadMutationStatus): String = value.name

    @TypeConverter
    fun toLeadMutationStatus(value: String): LeadMutationStatus = LeadMutationStatus.valueOf(value)
}

@Database(
    entities = [QueuedCallEntity::class, LeadMutationEntity::class],
    version = 2,
    exportSchema = true,
)
@TypeConverters(QueueConverters::class)
abstract class CalloraDatabase : RoomDatabase() {
    abstract fun queuedCalls(): QueuedCallDao
    abstract fun leadMutations(): LeadMutationDao

    companion object {
        fun create(context: Context): CalloraDatabase = Room.databaseBuilder(
            context.applicationContext,
            CalloraDatabase::class.java,
            "callora_queue.db",
        )
            .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
            .addMigrations(MIGRATION_1_2)
            .addCallback(object : RoomDatabase.Callback() {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    // `secure_delete` returns a result row on newer SQLite builds, so
                    // Android rejects it through execSQL(). Querying works across the
                    // supported API range and still applies the connection pragma.
                    db.query("PRAGMA secure_delete=ON").close()
                }
            })
            .build()

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `lead_mutations` (
                        `requestId` TEXT NOT NULL,
                        `organizationId` TEXT NOT NULL,
                        `employeeId` TEXT NOT NULL,
                        `deviceId` TEXT NOT NULL,
                        `leadId` TEXT NOT NULL,
                        `activeLeadKey` TEXT,
                        `encryptedCommand` TEXT NOT NULL,
                        `status` TEXT NOT NULL,
                        `attemptCount` INTEGER NOT NULL,
                        `availableAtEpochMillis` INTEGER NOT NULL,
                        `createdAtEpochMillis` INTEGER NOT NULL,
                        `updatedAtEpochMillis` INTEGER NOT NULL,
                        `lastErrorCode` TEXT,
                        PRIMARY KEY(`requestId`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_lead_mutations_status_availableAtEpochMillis_createdAtEpochMillis` " +
                        "ON `lead_mutations` (`status`, `availableAtEpochMillis`, `createdAtEpochMillis`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_lead_mutations_organizationId_employeeId_leadId_status` " +
                        "ON `lead_mutations` (`organizationId`, `employeeId`, `leadId`, `status`)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS `index_lead_mutations_activeLeadKey` " +
                        "ON `lead_mutations` (`activeLeadKey`)",
                )
            }
        }
    }
}
