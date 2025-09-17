#!/bin/bash

# Generate schema.yaml from PostgreSQL/Materialize database
# Usage: ./generate-schema.sh -s source1 -p pk1 [-s source2 -p pk2 ...] > schema.yaml
# Example: ./generate-schema.sh -s users -p id -s orders -p id > schema.yaml

set -e

# Check arguments
if [ $# -eq 0 ]; then
    echo "Usage: $0 -s source -p primary_key ..." >&2
    echo "Example: $0 -s users -p id -s orders -p id > schema.yaml" >&2
    echo "Note: Primary key is required for each source" >&2
    exit 1
fi

# Load .env file if it exists
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Database connection parameters
DB_HOST="${DATABASE_HOST:-localhost}"
DB_PORT="${DATABASE_PORT:-6875}"
DB_NAME="${DATABASE_NAME:-materialize}"
DB_USER="${DATABASE_USER:-materialize}"
DB_PASSWORD="${DATABASE_PASSWORD:-materialize}"

# PostgreSQL connection string
export PGPASSWORD="$DB_PASSWORD"
PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A -q"

# Function to map PostgreSQL types to DataTypes
map_type() {
    local pg_type="$1"
    local type_lower=$(echo "$pg_type" | tr '[:upper:]' '[:lower:]')

    case "$type_lower" in
        *int2*|smallint) echo "Integer" ;;
        *int4*|integer) echo "Integer" ;;
        *int8*|bigint) echo "BigInt" ;;
        *float*|real|"double precision") echo "Float" ;;
        *numeric*|*decimal*) echo "Float" ;;
        *varchar*|"character varying") echo "String" ;;
        *char*|character|text) echo "String" ;;
        uuid) echo "UUID" ;;
        *timestamp*) echo "Timestamp" ;;
        date) echo "Date" ;;
        *time*) echo "Time" ;;
        bool*) echo "Boolean" ;;
        *json*) echo "JSON" ;;
        *"[]"|array) echo "Array" ;;
        *) echo "String" ;;  # Default fallback
    esac
}

# Parse arguments to build list of sources and their primary keys
SOURCES=""
PRIMARY_KEYS=""
current_source=""
current_index=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--source)
            # Check if previous source has a primary key
            if [ -n "$current_source" ]; then
                # Check if PRIMARY_KEYS ends with | (meaning last source has no PK)
                if [ -z "$PRIMARY_KEYS" ] || [[ "$PRIMARY_KEYS" == *"|" ]]; then
                    echo "Error: Source '$current_source' requires a primary key (-p)" >&2
                    exit 1
                fi
            fi

            if [ -n "$2" ] && [[ ! "$2" =~ ^- ]]; then
                if [ -z "$SOURCES" ]; then
                    SOURCES="$2"
                    PRIMARY_KEYS=""
                else
                    SOURCES="$SOURCES|$2"
                    PRIMARY_KEYS="$PRIMARY_KEYS|"
                fi
                current_source="$2"
                ((current_index++))
                shift 2
            else
                echo "Error: -s requires a source name" >&2
                exit 1
            fi
            ;;
        -p|--pk|--primary-key)
            if [ -z "$current_source" ]; then
                echo "Error: -p must come after -s" >&2
                exit 1
            fi
            if [ -n "$2" ] && [[ ! "$2" =~ ^- ]]; then
                # Update the last primary key
                if [ -z "$PRIMARY_KEYS" ]; then
                    PRIMARY_KEYS="$2"
                else
                    # Replace the last empty slot with the PK
                    PRIMARY_KEYS="${PRIMARY_KEYS%|*}|$2"
                fi
                shift 2
            else
                echo "Error: -p requires a column name" >&2
                exit 1
            fi
            ;;
        *)
            echo "Error: Unknown option $1" >&2
            echo "Usage: $0 -s source [-p primary_key] ..." >&2
            exit 1
            ;;
    esac
done

# Check if the last source has a primary key
if [ -n "$current_source" ]; then
    if [ -z "$PRIMARY_KEYS" ] || [[ "$PRIMARY_KEYS" == *"|" ]]; then
        echo "Error: Source '$current_source' requires a primary key (-p)" >&2
        exit 1
    fi
fi

if [ -z "$SOURCES" ]; then
    echo "Error: No sources specified" >&2
    echo "Usage: $0 -s source -p primary_key ..." >&2
    exit 1
fi

# Start output
echo "sources:"

# Convert to arrays
IFS='|' read -ra SOURCE_ARRAY <<< "$SOURCES"
IFS='|' read -ra PK_ARRAY <<< "$PRIMARY_KEYS"

# Process each source
index=0
for source in "${SOURCE_ARRAY[@]}"; do
    # Get columns using SHOW COLUMNS
    COLUMNS=$($PSQL -c "SHOW COLUMNS FROM $source" 2>/dev/null)

    if [ -z "$COLUMNS" ]; then
        echo "Error: Source '$source' not found" >&2
        exit 1
    fi

    # Start this source
    echo "  $source:"

    # Add primary key (always present due to validation)
    pk="${PK_ARRAY[$index]}"
    echo "    primary_key: $pk"

    echo "    columns:"

    # Process each column (format: name|nullable|type)
    while IFS='|' read -r name nullable type; do
        mapped_type=$(map_type "$type")
        echo "      $name: $mapped_type"
    done <<< "$COLUMNS"

    ((index++))
done

echo "✅ Generated schema for ${#SOURCE_ARRAY[@]} source(s)" >&2