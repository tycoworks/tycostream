#!/bin/bash

# Generate schema.yaml from PostgreSQL/Materialize database
# Supports both tables and materialized views as sources
# Usage: ./generate-schema.sh [-e enum_name "value1,value2"] -s source1 -p pk1 [-c column:enum] [-s source2 -p pk2 ...] > schema.yaml
# Example:
#   ./generate-schema.sh \
#     -e side "buy,sell" \
#     -e event_type "FIRE,CLEAR" \
#     -s live_pnl -p instrument_id \
#     -s trades -p id -c side:side \
#     -s alerts -p id -c event_type:event_type > schema.yaml

set -e

# Check arguments
if [ $# -eq 0 ]; then
    echo "Usage: $0 [-e enum_name \"value1,value2\"] -s source -p primary_key [-c column:enum] ..." >&2
    echo "Example: $0 -e status \"pending,active\" -s users -p id -c user_status:status > schema.yaml" >&2
    echo "Note: Primary key is required for each source" >&2
    echo "      Use -c to map columns to enums (e.g., -c status:status or -c order_status:status)" >&2
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

# Parse arguments to build list of sources, primary keys, enums, and column mappings
SOURCES=""
PRIMARY_KEYS=""
ENUMS=""
COLUMN_MAPPINGS=""  # Pipe-separated list of source|column:enum mappings
current_source=""
current_enum=""
current_index=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -e|--enum)
            if [ -n "$2" ] && [[ ! "$2" =~ ^- ]]; then
                current_enum="$2"
                if [ -n "$3" ] && [[ ! "$3" =~ ^- ]]; then
                    # Store enum as name:values
                    if [ -z "$ENUMS" ]; then
                        ENUMS="$current_enum:$3"
                    else
                        ENUMS="$ENUMS|$current_enum:$3"
                    fi
                    shift 3
                else
                    echo "Error: -e requires enum name and values" >&2
                    echo "Example: -e status \"pending,active,completed\"" >&2
                    exit 1
                fi
            else
                echo "Error: -e requires an enum name" >&2
                exit 1
            fi
            ;;
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
        -c|--column)
            if [ -z "$current_source" ]; then
                echo "Error: -c must come after -s" >&2
                exit 1
            fi
            if [ -n "$2" ] && [[ ! "$2" =~ ^- ]]; then
                # Add column mapping for current source
                if [ -z "$COLUMN_MAPPINGS" ]; then
                    COLUMN_MAPPINGS="$current_source|$2"
                else
                    COLUMN_MAPPINGS="$COLUMN_MAPPINGS,$current_source|$2"
                fi
                shift 2
            else
                echo "Error: -c requires a column:enum mapping" >&2
                echo "Example: -c status:status or -c order_status:status" >&2
                exit 1
            fi
            ;;
        *)
            echo "Error: Unknown option $1" >&2
            echo "Usage: $0 [-e enum_name \"values\"] -s source -p primary_key [-c column:enum] ..." >&2
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
    echo "Usage: $0 [-e enum_name \"values\"] -s source -p primary_key [-c column:enum] ..." >&2
    exit 1
fi

# Output enums if any were defined
if [ -n "$ENUMS" ]; then
    echo "enums:"
    IFS='|' read -ra ENUM_ARRAY <<< "$ENUMS"
    for enum in "${ENUM_ARRAY[@]}"; do
        IFS=':' read -r name values <<< "$enum"
        echo "  $name:"
        IFS=',' read -ra VALUE_ARRAY <<< "$values"
        for value in "${VALUE_ARRAY[@]}"; do
            # Trim whitespace
            value=$(echo "$value" | xargs)
            echo "    - $value"
        done
    done
    echo ""
fi

# Start sources output
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

    # Process each column (format: name|nullable|type|comment)
    while IFS='|' read -r name nullable type comment; do
        # Check if this column has an explicit enum mapping
        enum_match=""
        if [ -n "$COLUMN_MAPPINGS" ]; then
            IFS=',' read -ra MAPPING_ARRAY <<< "$COLUMN_MAPPINGS"
            for mapping in "${MAPPING_ARRAY[@]}"; do
                IFS='|' read -r map_source map_col_enum <<< "$mapping"
                if [ "$map_source" = "$source" ]; then
                    IFS=':' read -r col_name enum_name <<< "$map_col_enum"
                    if [ "$col_name" = "$name" ]; then
                        enum_match="$enum_name"
                        break
                    fi
                fi
            done
        fi

        if [ -n "$enum_match" ]; then
            echo "      $name: $enum_match"
        else
            mapped_type=$(map_type "$type")
            echo "      $name: $mapped_type"
        fi
    done <<< "$COLUMNS"

    ((index++))
done

echo "✅ Generated schema for ${#SOURCE_ARRAY[@]} source(s)" >&2