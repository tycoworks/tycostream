import { createGrid, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';

ModuleRegistry.registerModules([AllCommunityModule]);

const columnConfig = getColumnConfig();
const fields = Object.keys(columnConfig);

const subscription = gql`
  subscription LivePnlSubscription {
    live_pnl {
      operation
      data {
        ${fields.join('\n        ')}
      }
      fields
    }
  }
`;

const gridApi = createPnlGrid();

const client = new ApolloClient({
  link: new GraphQLWsLink(createClient({ url: 'ws://localhost:4000/graphql' })),
  cache: new InMemoryCache()
});

client.subscribe({ query: subscription }).subscribe(({ data }) => {
  if (!data?.live_pnl) return;
  
  const { operation, data: rowData, fields: changedFields } = data.live_pnl;
  if (!rowData) return;
  
  switch (operation) {
    case 'DELETE':
      gridApi.applyTransaction({ remove: [rowData] });
      break;
    case 'UPDATE':
      const updatedRow = mergeWithExistingRow(rowData, changedFields);
      if (updatedRow) {
        gridApi.applyTransaction({ update: [updatedRow] });
      } else {
        console.warn(`UPDATE received for non-existent row with instrument_id=${rowData.instrument_id}`);
      }
      break;
    case 'INSERT':
      gridApi.applyTransaction({ add: [rowData] });
      break;
  }
});

function mergeWithExistingRow(deltaData, changedFields) {
  const rowNode = gridApi.getRowNode(String(deltaData.instrument_id));
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

function getColumnConfig() {
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

function createPnlGrid() {
  return createGrid(document.querySelector('#grid'), {
    columnDefs: fields.map(field => ({ field, ...columnConfig[field] })),
    rowData: [],
    getRowId: params => String(params.data.instrument_id)
  });
}