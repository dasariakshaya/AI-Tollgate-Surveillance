import pymongo
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime
import time

# ==========================================
# 1. CONFIGURATION
# ==========================================
MONGO_URI = "mongodb+srv://akshuandyou1826_db_user:vgtlpaizeAJZAXWF@tollgatedb-cluster.jjbai9a.mongodb.net/?retryWrites=true&w=majority&appName=TollgateDB-Cluster"
MONGO_DB_NAME = "licenseDB"

# CLOUD CREDENTIALS
PG_DB_NAME = "netra_db"
PG_USER = "netra_user"
PG_PASSWORD = "wP7yNldjeDhrUXRRJOcNc8zjRqLXa2jW"
PG_HOST = "dpg-d4gm6fqli9vc73dn3e1g-a.singapore-postgres.render.com"

# ==========================================
# 2. CONNECTION HELPERS
# ==========================================

def get_mongo_db():
    client = pymongo.MongoClient(MONGO_URI)
    return client[MONGO_DB_NAME]

def get_pg_connection():
    try:
        conn = psycopg2.connect(
            dbname=PG_DB_NAME, user=PG_USER, password=PG_PASSWORD, host=PG_HOST,
            sslmode='require', connect_timeout=10
        )
        return conn
    except Exception as e:
        print(f"   ❌ Connection failed: {e}")
        return None

# Initialize
mongo_db = get_mongo_db()
pg_conn = get_pg_connection()
if not pg_conn: exit()
pg_cursor = pg_conn.cursor()

# ==========================================
# 3. MAPPING FUNCTIONS
# ==========================================

def map_rc(doc):
    reg_num = doc.get("regn_number") or doc.get("registration_number") or doc.get("rc_number") or ""
    return (
        reg_num.replace(" ", "").upper(), doc.get("verification", "valid"),
        doc.get("owner_name", "N/A"), "Not specified",
        doc.get("engine_number", "N/A"), doc.get("chassis_number", "N/A"),
        datetime.now(), datetime.now()
    )

def map_log(doc):
    return (
        doc.get("timestamp", datetime.now()), doc.get("scanned_by", "System"),
        doc.get("location", "Unknown"), doc.get("tollgate", "Unknown"),
        doc.get("dl_number"), doc.get("dl_name"), doc.get("phone_number"),
        doc.get("dl_status"), doc.get("vehicle_number"), doc.get("owner_name"),
        doc.get("engine_number"), doc.get("chassis_number"), doc.get("rc_status"),
        doc.get("driver_status"), doc.get("driver_name"), doc.get("alert_type"),
        doc.get("description"), doc.get("suspicious", False),
        datetime.now(), datetime.now()
    )

# ==========================================
# 4. PAGINATED MIGRATION (No Timeouts!)
# ==========================================

def migrate_collection_safe(mongo_coll_name, pg_table_name, pg_columns, map_function):
    global pg_conn, pg_cursor
    print(f"\n🚀 Migrating '{mongo_coll_name}' -> '{pg_table_name}'...")

    # Verify Collection Exists
    if mongo_coll_name not in mongo_db.list_collection_names():
        if mongo_coll_name + "s" in mongo_db.list_collection_names(): mongo_coll_name += "s"
        elif mongo_coll_name.rstrip("s") in mongo_db.list_collection_names(): mongo_coll_name = mongo_coll_name.rstrip("s")
        else:
             print(f"   ⚠️ Collection '{mongo_coll_name}' not found. Skipping.")
             return

    # PAGINATION VARIABLES
    last_id = None
    batch_size = 100 # Safe size
    total_migrated = 0
    col_str = ", ".join(pg_columns)
    query_sql = f'INSERT INTO "{pg_table_name}" ({col_str}) VALUES %s ON CONFLICT DO NOTHING'

    while True:
        # 1. Fetch next batch using _id > last_id
        mongo_query = {}
        if last_id:
            mongo_query['_id'] = {'$gt': last_id}
            
        # This query is fresh every time, so NO CursorNotFound errors!
        docs = list(mongo_db[mongo_coll_name].find(mongo_query).sort('_id').limit(batch_size))
        
        if not docs:
            break # No more data, we are done!

        # 2. Map Data
        batch_data = []
        for doc in docs:
            try:
                record = map_function(doc)
                if record: batch_data.append(record)
            except: pass
            last_id = doc['_id'] # Save position

        # 3. Insert into Postgres (With Retry)
        if batch_data:
            attempts = 0
            while attempts < 5:
                try:
                    execute_values(pg_cursor, query_sql, batch_data)
                    pg_conn.commit()
                    total_migrated += len(batch_data)
                    print(f"   ...migrated {total_migrated} records", end="\r")
                    time.sleep(0.1) # Be gentle
                    break
                except Exception as e:
                    print(f"\n   ⚠️ Postgres Error: {e}. Reconnecting...")
                    time.sleep(2)
                    attempts += 1
                    try:
                        pg_conn = get_pg_connection()
                        pg_cursor = pg_conn.cursor()
                    except: pass

    print(f"\n   ✅ Finished {mongo_coll_name}: {total_migrated} records processed.")

# ==========================================
# 5. EXECUTE
# ==========================================

# Users and Licenses are skipped (commented out)

# 3. RegistrationCertificates
migrate_collection_safe("registration_certificates", "RegistrationCertificates",
    ["regn_number", "verification", "owner_name", "crime_involved", "engine_number", "chassis_number", "\"createdAt\"", "\"updatedAt\""],
    map_rc
)

# 4. Logs
migrate_collection_safe("logs", "Logs",
    ["timestamp", "scanned_by", "location", "tollgate", "dl_number", "dl_name", "phone_number", "dl_status", "vehicle_number", "owner_name", "engine_number", "chassis_number", "rc_status", "driver_status", "driver_name", "alert_type", "description", "suspicious", "\"createdAt\"", "\"updatedAt\""],
    map_log
)

print("\n✨ Migration Complete.")