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
    }
  }
`;

const gridApi = createPnlGrid();

const client = new ApolloClient({
  link: new GraphQLWsLink(createClient({ url: 'ws://localhost:4000/graphql' })),
  cache: new InMemoryCache()
});

client.subscribe({ query: subscription }).subscribe(({ data }) => {
  if (data?.live_pnl) {
    const { operation, data: rowData } = data.live_pnl;
    
    if (operation === 'DELETE' && rowData) {
      gridApi.applyTransaction({ remove: [rowData] });
    } else if (operation === 'UPDATE' && rowData) {
      gridApi.applyTransaction({ update: [rowData] });
    } else if (operation === 'INSERT' && rowData) {
      gridApi.applyTransaction({ add: [rowData] });
    }
  }
});

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
    unrealized_pnl: { 
      headerName: 'Unrealized P&L',
      valueFormatter: params => params.value != null 
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(params.value)
        : '',
      cellStyle: params => ({
        color: params.value > 0 ? 'green' : params.value < 0 ? 'red' : 'black'
      })
    }
  };
}

function createPnlGrid() {
  return createGrid(document.querySelector('#grid'), {
    columnDefs: fields.map(field => ({ field, ...columnConfig[field] })),
    rowData: [],
    getRowId: params => String(params.data.instrument_id)
  });
}