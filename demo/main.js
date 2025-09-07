import { createGrid, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';

ModuleRegistry.registerModules([AllCommunityModule]);

// State for currently selected instrument
let selectedInstrumentId = null;
let tradesSubscription = null;
let alertsSubscription = null;

// Setup positions grid
const positionsColumnConfig = getPositionsColumnConfig();
const positionsFields = Object.keys(positionsColumnConfig);

// GraphQL query strings
const POSITIONS_SUBSCRIPTION = `
  subscription LivePnlSubscription {
    live_pnl {
      operation
      data {
        ${positionsFields.join('\n        ')}
      }
      fields
    }
  }
`;

const positionsGridApi = createPositionsGrid();

// Setup trades grid
const tradesColumnConfig = getTradesColumnConfig();
const tradesFields = Object.keys(tradesColumnConfig);

const TRADES_SUBSCRIPTION = `
  subscription TradesSubscription {
    trades(where: {instrument_id: {_eq: $instrumentId}}) {
      operation
      data {
        ${tradesFields.join('\n        ')}
      }
      fields
    }
  }
`;

const tradesGridApi = createTradesGrid();

// Setup alerts grid
const alertsColumnConfig = getAlertsColumnConfig();
const alertsFields = Object.keys(alertsColumnConfig);

const ALERTS_SUBSCRIPTION = `
  subscription AlertsSubscription {
    alerts {
      operation
      data {
        ${alertsFields.join('\n        ')}
      }
      fields
    }
  }
`;

const alertsGridApi = createAlertsGrid();

// Setup Apollo client
const wsClient = createClient({ url: 'ws://localhost:4000/graphql' });
const client = new ApolloClient({
  link: new GraphQLWsLink(wsClient),
  cache: new InMemoryCache()
});

// Subscribe to positions
subscribeToPositions();

// Subscribe to alerts
subscribeToAlerts();

// Create position trigger for large realized P&L losses
createPositionTrigger();

function subscribeToPositions() {
  client.subscribe({ query: gql(POSITIONS_SUBSCRIPTION) }).subscribe(({ data }) => {
    if (!data?.live_pnl) return;
    
    const { operation, data: rowData, fields: changedFields } = data.live_pnl;
    if (!rowData) return;
    
    handleGridUpdate(positionsGridApi, operation, rowData, changedFields, 'instrument_id');
    
    // If deleted position was selected, clear trades
    if (operation === 'DELETE' && rowData.instrument_id === selectedInstrumentId) {
      selectPosition(null);
    }
  });
}

function subscribeToAlerts() {
  alertsSubscription = client.subscribe({ query: gql(ALERTS_SUBSCRIPTION) }).subscribe(({ data }) => {
    if (!data?.alerts) return;
    
    const { operation, data: rowData, fields: changedFields } = data.alerts;
    if (!rowData) return;
    
    // Add alerts at the top for newest first
    handleGridUpdate(alertsGridApi, operation, rowData, changedFields, 'id', 0);
  });
}

function createPositionTrigger() {
  const CREATE_TRIGGER_MUTATION = gql`
    mutation CreatePositionTrigger {
      create_live_pnl_trigger(input: {
        name: "large_realized_loss",
        webhook: "http://localhost:3001/webhook",
        fire: {
          realized_pnl: { _lt: -1000000 }
        },
        clear: {
          realized_pnl: { _gte: -500000 }
        }
      }) {
        name
        webhook
      }
    }
  `;
  
  client.mutate({
    mutation: CREATE_TRIGGER_MUTATION
  });
}

function handleGridUpdate(gridApi, operation, rowData, changedFields, idField, addIndex) {
  switch (operation) {
    case 'DELETE':
      gridApi.applyTransaction({ remove: [rowData] });
      break;
    case 'UPDATE':
      const updatedRow = mergeWithExistingRow(gridApi, rowData, changedFields, idField);
      if (updatedRow) {
        gridApi.applyTransaction({ update: [updatedRow] });
      } else {
        console.warn(`UPDATE received for non-existent row with ${idField}=${rowData[idField]}`);
      }
      break;
    case 'INSERT':
      const options = addIndex !== undefined 
        ? { add: [rowData], addIndex }
        : { add: [rowData] };
      gridApi.applyTransaction(options);
      break;
  }
}

function selectPosition(instrumentId) {
  // Unsubscribe from previous trades subscription
  if (tradesSubscription) {
    tradesSubscription.unsubscribe();
    tradesSubscription = null;
  }
  
  selectedInstrumentId = instrumentId;
  
  // Clear trades grid
  const allRows = [];
  tradesGridApi.forEachNode(node => allRows.push(node.data));
  tradesGridApi.applyTransaction({ remove: allRows });
  
  // If no position selected, we're done
  if (!instrumentId) return;
  
  // Subscribe to trades for this instrument
  const tradesQuery = TRADES_SUBSCRIPTION.replace('$instrumentId', instrumentId);
  tradesSubscription = client.subscribe({ query: gql(tradesQuery) }).subscribe(({ data }) => {
    if (!data?.trades) return;
    
    const { operation, data: rowData, fields: changedFields } = data.trades;
    if (!rowData) return;
    
    // Add at the top for newest trades first
    handleGridUpdate(tradesGridApi, operation, rowData, changedFields, 'id', 0);
  });
}

function mergeWithExistingRow(gridApi, deltaData, changedFields, idField) {
  const rowNode = gridApi.getRowNode(String(deltaData[idField]));
  if (!rowNode?.data) return null;
  
  // Start with existing row data
  const merged = { ...rowNode.data };
  
  // Apply only the changed fields
  if (changedFields && changedFields.length > 0) {
    changedFields.forEach(field => {
      if (field in deltaData) {
        merged[field] = deltaData[field];
      }
    });
  }
  
  return merged;
}

function getPositionsColumnConfig() {
  return {
    instrument_id: { hide: true },
    symbol: { headerName: 'Symbol' },
    last_price: { 
      headerName: 'Last Price',
      valueFormatter: params => params.value != null ? Number(params.value).toFixed(2) : '',
      cellRenderer: 'agAnimateShowChangeCellRenderer',
      minWidth: 120
    },
    net_position: { 
      headerName: 'Net Position',
      valueFormatter: params => params.value != null ? Number(params.value).toLocaleString() : ''
    },
    market_value: { 
      headerName: 'Market Value',
      valueFormatter: params => params.value != null 
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(params.value)
        : ''
    },
    realized_pnl: { 
      headerName: 'Realized P&L',
      ...getPnlColumnConfig()
    },
    unrealized_pnl: { 
      headerName: 'Unrealized P&L',
      ...getPnlColumnConfig()
    }
  };
}

function getTradesColumnConfig() {
  return {
    executed_at: { 
      headerName: 'Executed At',
      width: 200,
      valueFormatter: params => {
        if (!params.value) return '';
        const date = new Date(params.value);
        return date.toLocaleString();
      }
    },
    id: { hide: true },
    instrument_id: { hide: true },
    quantity: { 
      headerName: 'Quantity',
      width: 120,
      valueFormatter: params => params.value != null ? Number(params.value).toLocaleString() : ''
    },
    price: { 
      headerName: 'Price',
      width: 120,
      valueFormatter: params => params.value != null ? Number(params.value).toFixed(2) : ''
    }
  };
}

function getAlertsColumnConfig() {
  return {
    id: { hide: true },
    event_id: { 
      headerName: 'Event ID',
      width: 150
    },
    timestamp: { 
      headerName: 'Timestamp',
      width: 200,
      valueFormatter: params => {
        if (!params.value) return '';
        const date = new Date(params.value);
        return date.toLocaleString();
      }
    },
    trigger_name: { 
      headerName: 'Trigger',
      width: 150
    },
    event_type: { 
      headerName: 'Event',
      width: 120,
      cellStyle: params => ({
        color: params.value === 'FIRE' ? 'orange' : params.value === 'CLEAR' ? 'green' : 'black',
      })
    },
    data: { 
      headerName: 'Data',
      flex: 1,
      valueFormatter: params => {
        if (!params.value) return '';
        try {
          const parsed = JSON.parse(params.value);
          return JSON.stringify(parsed, null, 2);
        } catch {
          return params.value;
        }
      }
    }
  };
}

function getPnlColumnConfig() {
  return {
    valueFormatter: params => params.value != null 
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(params.value)
      : '',
    cellStyle: params => ({
      color: params.value > 0 ? 'green' : params.value < 0 ? 'red' : 'black'
    })
  };
}

function createPositionsGrid() {
  const gridApi = createGrid(document.querySelector('#positions-grid'), {
    theme: 'legacy',
    columnDefs: positionsFields.map(field => ({ field, ...positionsColumnConfig[field] })),
    rowData: [],
    getRowId: params => String(params.data.instrument_id),
    rowSelection: { mode: 'singleRow' },
    onRowClicked: (event) => {
      const instrumentId = event.data.instrument_id;
      selectPosition(instrumentId);
    },
    defaultColDef: {
      resizable: true
    },
    autoSizeStrategy: {
      type: 'fitGridWidth'
    }
  });
  
  return gridApi;
}

function createTradesGrid() {
  return createGrid(document.querySelector('#trades-grid'), {
    theme: 'legacy',
    columnDefs: tradesFields.map(field => ({ field, ...tradesColumnConfig[field] })),
    rowData: [],
    getRowId: params => String(params.data.id),
    defaultColDef: {
      sortable: true,
      resizable: true
    },
    autoSizeStrategy: {
      type: 'fitGridWidth'
    }
  });
}

function createAlertsGrid() {
  return createGrid(document.querySelector('#alerts-grid'), {
    theme: 'legacy',
    columnDefs: alertsFields.map(field => ({ field, ...alertsColumnConfig[field] })),
    rowData: [],
    getRowId: params => String(params.data.id),
    defaultColDef: {
      sortable: true,
      resizable: true
    }
  });
}