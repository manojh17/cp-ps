from pymongo import MongoClient

MONGO_URI = "mongodb+srv://test:28Z7TCRykBfpigiq@it.5yl39aq.mongodb.net/?appName=IT"

try:
    client = MongoClient(
        MONGO_URI,
        serverSelectionTimeoutMS=5000
    )

    # Force connection test
    client.admin.command("ping")

    print("MongoDB connection successful!")

except Exception as e:
    print("MongoDB connection failed!")
    print(e)

finally:
    client.close()