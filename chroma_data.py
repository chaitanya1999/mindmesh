import chromadb

# 1. Initialize the client 
# Use HttpClient to connect to your running server
client = chromadb.HttpClient(host='localhost', port=8000)

# 2. Get the list of all collection names
# list_collections() returns a list of Collection objects or names depending on version
collections = client.list_collections()

print(f"{'Collection Name':<30} | {'Record Count'}")
print("-" * 45)

# 3. Iterate through collections and get counts
for col in collections:
    # Handle both object-based and string-based returns from list_collections
    col_name = col.name if hasattr(col, 'name') else col
    
    # Access the collection
    collection = client.get_collection(name=col_name)
    
    # Get total records
    count = collection.count()
    
    print(f"{col_name:<30} | {count}")